import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserActionError, type BrowserAction } from '../../ports/computer.ts';
import type {
  AntiBotChallengeKind,
  AntiBotDetection,
  StealthBrowserMode,
  StealthBrowserProvider,
  StealthDoctorResult,
  StealthExecutionResult,
  StealthSessionOptions,
} from '../../ports/stealth-browser.ts';
import type { BrowserErrorCode } from '../../shared/browser-errors.ts';

export interface BrowseCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type BrowseCommandRunner = (
  file: string,
  args: readonly string[],
  options?: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
) => Promise<BrowseCommandResult>;

export interface BrowserbaseCliProviderConfig {
  apiKey?: string;
  chromePath?: string;
  browseBin?: string;
  defaultSession?: string;
  defaultMode?: StealthBrowserMode;
  autoEscalate?: boolean;
  runCommand?: BrowseCommandRunner;
}

interface SessionState {
  currentUrl: string;
  mode: StealthBrowserMode;
  verified: boolean;
  proxies: boolean;
  lastTitle?: string;
}

const cloudflarePattern =
  /cloudflare|cf-turnstile|challenges\.cloudflare\.com|turnstile|just a moment\.\.\.|checking your browser before accessing|checking if the site connection is secure|ddos protection by cloudflare|attention required!/i;

const captchaPattern =
  /verify you are human|are you human|are you a robot|i am not a robot|i'm not a robot|human verification|complete the security check|press\s*(?:&|and)\s*hold|captcha|recaptcha|g-recaptcha|hcaptcha|arkoselabs|funcaptcha|geetest|px-captcha|perimeterx/i;

const botBlockPattern =
  /access denied|you have been blocked|sorry,\s*you have been blocked|bot detected|automated access|unusual traffic|enable javascript and cookies to continue|403 forbidden|datadome|imperva|incapsula|akamai|request blocked|pardon our interruption/i;

function normalizeSessionName(session?: string): string {
  const trimmed = session?.trim() ?? '';
  if (!trimmed) return 'default';
  if (/[\s\0\\/]/.test(trimmed) || trimmed.startsWith('-')) {
    throw new Error(`Invalid stealth browser session name: ${trimmed}`);
  }
  return trimmed;
}

export function buildBrowseArgs(
  command: string | readonly string[],
  options?: StealthSessionOptions,
): string[] {
  const commandParts = (typeof command === 'string' ? [command] : [...command]).filter(
    (part) => part.length > 0,
  );
  if (commandParts.length === 0) {
    throw new Error('Browse command must not be empty.');
  }
  const session = normalizeSessionName(options?.session);
  const mode: StealthBrowserMode = options?.mode === 'remote' ? 'remote' : 'local';
  const args = [...commandParts, '--session', session, mode === 'remote' ? '--remote' : '--local'];
  if (mode === 'remote') {
    if (options?.verified) args.push('--verified');
    if (options?.proxies) args.push('--proxies');
  }
  return args;
}

export function detectAntiBotChallenge(observationText: string, title?: string): AntiBotDetection {
  const combined = `${title ?? ''}\n${observationText ?? ''}`;
  let challenge: AntiBotChallengeKind = 'none';
  if (cloudflarePattern.test(combined)) {
    challenge = 'cloudflare';
  } else if (captchaPattern.test(combined)) {
    challenge = 'captcha';
  } else if (botBlockPattern.test(combined)) {
    challenge = 'bot_block';
  }
  return {
    challenge,
    escalateToRemote: challenge !== 'none',
  };
}

function resolveBrowseInvocation(
  file: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): { executable: string; finalArgs: string[] } {
  if (process.platform === 'win32' && file === 'browse') {
    const appData = env?.APPDATA ?? process.env.APPDATA;
    if (appData) {
      const entry = join(appData, 'npm', 'node_modules', 'browse', 'bin', 'run.js');
      if (existsSync(entry)) {
        return { executable: process.execPath, finalArgs: [entry, ...args] };
      }
    }
  }
  return { executable: file, finalArgs: [...args] };
}

function defaultRunCommand(
  file: string,
  args: readonly string[],
  options?: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<BrowseCommandResult> {
  const { executable, finalArgs } = resolveBrowseInvocation(file, args, options?.env);
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      finalArgs,
      {
        env: options?.env,
        timeout: options?.timeoutMs,
        signal: options?.signal,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const err = error as NodeJS.ErrnoException & { code?: number | string };
          if (typeof err.code === 'number') {
            resolve({
              stdout: String(stdout ?? ''),
              stderr: String(stderr ?? ''),
              exitCode: err.code,
            });
            return;
          }
          reject(error);
          return;
        }
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          exitCode: 0,
        });
      },
    );
  });
}

function parseObservation(
  rawOutput: string,
  fallbackUrl: string,
  fallbackTitle?: string,
): { text: string; url: string; title?: string } {
  const trimmed = rawOutput.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const textCandidate = parsed.text ?? parsed.snapshot ?? parsed.content;
      const text = typeof textCandidate === 'string' ? textCandidate : trimmed;
      const url = typeof parsed.url === 'string' && parsed.url ? parsed.url : fallbackUrl;
      const title = typeof parsed.title === 'string' && parsed.title ? parsed.title : fallbackTitle;
      return { text, url, title };
    } catch {
      return { text: trimmed, url: fallbackUrl, title: fallbackTitle };
    }
  }
  const urlMatch = /^URL:\s*(https?:\/\/\S+)$/im.exec(trimmed);
  const titleMatch = /^Title:\s*(.+)$/im.exec(trimmed);
  return {
    text: trimmed,
    url: urlMatch?.[1]?.trim() || fallbackUrl,
    title: titleMatch?.[1]?.trim() || fallbackTitle,
  };
}

function errorCodeForAction(action: BrowserAction['action']): BrowserErrorCode {
  if (action === 'open') return 'browser_navigation_failed';
  if (action === 'snapshot') return 'browser_observation_failed';
  return 'browser_action_failed';
}

function actionToCommand(action: BrowserAction): string[] {
  switch (action.action) {
    case 'open': {
      if (!action.url) {
        throw new BrowserActionError('browser_navigation_failed', 'open requires a url.');
      }
      return ['open', action.url];
    }
    case 'snapshot':
      return ['snapshot'];
    case 'click': {
      if (action.selector) return ['click', action.selector];
      if (action.x !== undefined && action.y !== undefined) {
        return ['click', String(action.x), String(action.y)];
      }
      throw new BrowserActionError(
        'browser_action_failed',
        'click requires a selector or coordinates.',
      );
    }
    case 'fill': {
      if (!action.selector || action.text === undefined) {
        throw new BrowserActionError(
          'browser_action_failed',
          'fill requires both selector and text.',
        );
      }
      return ['fill', action.selector, action.text];
    }
    case 'type': {
      if (action.text === undefined) {
        throw new BrowserActionError('browser_action_failed', 'type requires text.');
      }
      return action.selector ? ['type', action.selector, action.text] : ['type', action.text];
    }
    case 'press': {
      if (!action.key) {
        throw new BrowserActionError('browser_action_failed', 'press requires a key.');
      }
      return ['press', action.key];
    }
    case 'scroll': {
      const direction = action.direction ?? 'down';
      return action.amount !== undefined
        ? ['scroll', direction, String(action.amount)]
        : ['scroll', direction];
    }
    case 'select': {
      if (!action.selector || action.text === undefined) {
        throw new BrowserActionError('browser_action_failed', 'select requires selector and text.');
      }
      return ['select', action.selector, action.text];
    }
    case 'check': {
      if (!action.selector) {
        throw new BrowserActionError('browser_action_failed', 'check requires a selector.');
      }
      return ['check', action.selector];
    }
    case 'uncheck': {
      if (!action.selector) {
        throw new BrowserActionError('browser_action_failed', 'uncheck requires a selector.');
      }
      return ['uncheck', action.selector];
    }
    case 'hover': {
      if (!action.selector) {
        throw new BrowserActionError('browser_action_failed', 'hover requires a selector.');
      }
      return ['hover', action.selector];
    }
    case 'drag': {
      if (!action.selector || !action.targetSelector) {
        throw new BrowserActionError(
          'browser_action_failed',
          'drag requires selector and targetSelector.',
        );
      }
      return ['drag', action.selector, action.targetSelector];
    }
    case 'back':
      return ['back'];
    case 'forward':
      return ['forward'];
    case 'reload':
      return ['reload'];
    case 'tab_list':
      return ['tab', 'list'];
    case 'tab_switch': {
      if (!action.tabId) {
        throw new BrowserActionError('browser_action_failed', 'tab_switch requires tabId.');
      }
      return ['tab', 'switch', action.tabId];
    }
    case 'evaluate': {
      if (!action.script) {
        throw new BrowserActionError('browser_action_failed', 'evaluate requires script.');
      }
      return ['evaluate', action.script];
    }
    case 'wait': {
      if (action.selector) return ['wait', action.selector];
      return ['wait', String(action.waitMs ?? action.durationMs ?? 1000)];
    }
    case 'accept_dialog':
      return ['dialog', 'accept'];
    case 'dismiss_dialog':
      return ['dialog', 'dismiss'];
  }
}

export function createBrowserbaseCliProvider(
  config: BrowserbaseCliProviderConfig = {},
): StealthBrowserProvider {
  const apiKey = config.apiKey?.trim() || undefined;
  const defaultChromePath = config.chromePath?.trim() || undefined;
  const browseBin = config.browseBin?.trim() || 'browse';
  const defaultSession = normalizeSessionName(config.defaultSession);
  const defaultMode: StealthBrowserMode = config.defaultMode === 'remote' ? 'remote' : 'local';
  const autoEscalate = config.autoEscalate ?? true;
  const runCommand = config.runCommand ?? defaultRunCommand;
  const sessions = new Map<string, SessionState>();

  function resolveSessionOptions(
    options?: StealthSessionOptions,
  ): Required<Pick<StealthSessionOptions, 'session' | 'mode' | 'verified' | 'proxies'>> &
    Pick<StealthSessionOptions, 'chromePath' | 'timeoutMs' | 'signal'> {
    const session = normalizeSessionName(options?.session ?? defaultSession);
    const existing = sessions.get(session);
    const mode: StealthBrowserMode = options?.mode ?? existing?.mode ?? defaultMode;
    const verified = mode === 'remote' ? (options?.verified ?? existing?.verified ?? false) : false;
    const proxies = mode === 'remote' ? (options?.proxies ?? existing?.proxies ?? false) : false;
    return {
      session,
      mode,
      verified,
      proxies,
      chromePath: options?.chromePath ?? defaultChromePath,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    };
  }

  function buildEnv(chromePath?: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...(apiKey ? { BROWSERBASE_API_KEY: apiKey } : {}),
      ...(chromePath ? { CHROME_PATH: chromePath } : {}),
    };
  }

  async function invokeBrowse(
    command: readonly string[],
    resolved: ReturnType<typeof resolveSessionOptions>,
  ): Promise<BrowseCommandResult> {
    const args = buildBrowseArgs(command, resolved);
    return runCommand(browseBin, args, {
      env: buildEnv(resolved.chromePath),
      timeoutMs: resolved.timeoutMs,
      signal: resolved.signal,
    });
  }

  async function runObservedAction(
    actionKind: BrowserAction['action'],
    command: readonly string[],
    options?: StealthSessionOptions,
    targetUrl?: string,
  ): Promise<StealthExecutionResult> {
    const resolved = resolveSessionOptions(options);
    const existing = sessions.get(resolved.session);
    const fallbackUrl = targetUrl ?? existing?.currentUrl ?? '';
    const result = await invokeBrowse(command, resolved);
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
      throw new BrowserActionError(errorCodeForAction(actionKind), detail);
    }

    const parsed = parseObservation(result.stdout, fallbackUrl, existing?.lastTitle);
    const nextState: SessionState = {
      currentUrl: parsed.url,
      mode: resolved.mode,
      verified: resolved.verified,
      proxies: resolved.proxies,
      lastTitle: parsed.title,
    };
    sessions.set(resolved.session, nextState);

    const detection = detectAntiBotChallenge(parsed.text, parsed.title);
    if (resolved.mode === 'local' && detection.escalateToRemote) {
      const escalationUrl = targetUrl || parsed.url || existing?.currentUrl;
      if (apiKey && autoEscalate && escalationUrl) {
        const remoteOptions = {
          ...resolved,
          mode: 'remote' as const,
          verified: true,
          proxies: true,
        };
        const remoteResult = await invokeBrowse(['open', escalationUrl], remoteOptions);
        if (remoteResult.exitCode !== 0) {
          const detail =
            remoteResult.stderr.trim() ||
            remoteResult.stdout.trim() ||
            `exit code ${remoteResult.exitCode}`;
          throw new BrowserActionError('browser_navigation_failed', detail);
        }
        const remoteParsed = parseObservation(
          remoteResult.stdout,
          escalationUrl,
          existing?.lastTitle,
        );
        sessions.set(resolved.session, {
          currentUrl: remoteParsed.url,
          mode: 'remote',
          verified: true,
          proxies: true,
          lastTitle: remoteParsed.title,
        });
        const remoteDetection = detectAntiBotChallenge(remoteParsed.text, remoteParsed.title);
        return {
          observation: { text: remoteParsed.text, url: remoteParsed.url },
          title: remoteParsed.title,
          mode: 'remote',
          session: resolved.session,
          challenge: remoteDetection.challenge,
          escalateToRemote: remoteDetection.escalateToRemote,
          escalated: true,
          escalatedFromChallenge: detection.challenge,
          escalationReason: `Escalated session "${resolved.session}" to remote (--verified --proxies) after detecting ${detection.challenge} challenge.`,
          rawOutput: remoteResult.stdout,
        };
      }

      const escalationReason = !apiKey
        ? `Anti-bot challenge (${detection.challenge}) detected in local mode; Browserbase API key required for --remote --verified --proxies escalation.`
        : !autoEscalate
          ? `Anti-bot challenge (${detection.challenge}) detected in local mode; remote escalation available via --remote --verified --proxies.`
          : `Anti-bot challenge (${detection.challenge}) detected in local mode; no target URL available for remote escalation.`;

      return {
        observation: { text: parsed.text, url: parsed.url },
        title: parsed.title,
        mode: resolved.mode,
        session: resolved.session,
        challenge: detection.challenge,
        escalateToRemote: true,
        escalated: false,
        escalationReason,
        rawOutput: result.stdout,
      };
    }

    return {
      observation: { text: parsed.text, url: parsed.url },
      title: parsed.title,
      mode: resolved.mode,
      session: resolved.session,
      challenge: detection.challenge,
      escalateToRemote: detection.escalateToRemote,
      escalated: false,
      rawOutput: result.stdout,
    };
  }

  return {
    async open(url: string, options?: StealthSessionOptions): Promise<StealthExecutionResult> {
      return runObservedAction('open', actionToCommand({ action: 'open', url }), options, url);
    },

    async snapshot(options?: StealthSessionOptions): Promise<StealthExecutionResult> {
      return runObservedAction('snapshot', ['snapshot'], options);
    },

    async title(options?: StealthSessionOptions): Promise<string> {
      const resolved = resolveSessionOptions(options);
      const result = await invokeBrowse(['get', 'title'], resolved);
      if (result.exitCode !== 0) {
        const detail =
          result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
        throw new BrowserActionError('browser_observation_failed', detail);
      }
      const rawTitle = result.stdout.trim();
      let pageTitle = rawTitle;
      if (rawTitle.startsWith('{')) {
        try {
          const parsed = JSON.parse(rawTitle) as { title?: unknown };
          if (typeof parsed.title === 'string') {
            pageTitle = parsed.title.trim();
          }
        } catch {
          pageTitle = rawTitle;
        }
      }
      const existing = sessions.get(resolved.session);
      if (existing) {
        existing.lastTitle = pageTitle;
      } else {
        sessions.set(resolved.session, {
          currentUrl: '',
          mode: resolved.mode,
          verified: resolved.verified,
          proxies: resolved.proxies,
          lastTitle: pageTitle,
        });
      }
      return pageTitle;
    },

    async executeAction(
      action: BrowserAction,
      options?: StealthSessionOptions,
    ): Promise<StealthExecutionResult> {
      const command = actionToCommand(action);
      return runObservedAction(
        action.action,
        command,
        options,
        action.action === 'open' ? action.url : undefined,
      );
    },

    async stop(options?: StealthSessionOptions): Promise<void> {
      const resolved = resolveSessionOptions(options);
      const result = await invokeBrowse(['stop'], resolved);
      sessions.delete(resolved.session);
      if (result.exitCode !== 0) {
        const detail =
          result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
        throw new BrowserActionError('browser_action_failed', detail);
      }
    },

    async doctor(options?: StealthSessionOptions): Promise<StealthDoctorResult> {
      const resolved = resolveSessionOptions(options);
      try {
        const result = await invokeBrowse(['doctor'], resolved);
        return {
          ok: result.exitCode === 0,
          mode: resolved.mode,
          output: (result.stdout || result.stderr).trim(),
          chromePath: resolved.chromePath,
          remoteAvailable: Boolean(apiKey),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          mode: resolved.mode,
          output: message,
          chromePath: resolved.chromePath,
          remoteAvailable: Boolean(apiKey),
        };
      }
    },
  };
}
