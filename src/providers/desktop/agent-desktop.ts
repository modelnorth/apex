import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DesktopActionOptions,
  DesktopActionResult,
  DesktopApp,
  DesktopNode,
  DesktopPermissionState,
  DesktopPlatform,
  DesktopPort,
  DesktopSnapshotOptions,
  DesktopSnapshotResult,
  DesktopStatus,
  DesktopWindow,
} from '../../ports/desktop.ts';

export interface AgentDesktopCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type AgentDesktopCommandRunner = (
  file: string,
  args: readonly string[],
  options?: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
) => Promise<AgentDesktopCommandResult>;

export interface AgentDesktopConfig {
  executablePath?: string;
  env?: NodeJS.ProcessEnv;
  defaultTimeoutMs?: number;
  runCommand?: AgentDesktopCommandRunner;
}

interface CliEnvelope<T = unknown> {
  version?: string;
  ok: boolean;
  command?: string;
  data?: T;
  error?: {
    code: string;
    message: string;
    disposition?: {
      delivery: string;
      retry: 'safe' | 'unsafe' | 'terminal';
    };
  };
}

function resolveAgentDesktopBinary(customPath?: string, env?: NodeJS.ProcessEnv): string {
  if (customPath && existsSync(customPath)) {
    return customPath;
  }
  if (process.platform === 'win32') {
    const appData = env?.APPDATA ?? process.env.APPDATA;
    if (appData) {
      const winExe = join(
        appData,
        'npm',
        'node_modules',
        'agent-desktop',
        'bin',
        'agent-desktop-win32-x64.exe',
      );
      if (existsSync(winExe)) {
        return winExe;
      }
    }
  }
  return 'agent-desktop';
}

function defaultRunCommand(
  file: string,
  args: readonly string[],
  options?: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<AgentDesktopCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
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

function parseJsonEnvelope<T = unknown>(stdout: string, stderr: string): CliEnvelope<T> {
  const trimmed = stdout.trim() || stderr.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: {
        code: 'EMPTY_OUTPUT',
        message: 'agent-desktop produced no output',
      },
    };
  }
  try {
    return JSON.parse(trimmed) as CliEnvelope<T>;
  } catch {
    return {
      ok: false,
      error: {
        code: 'INVALID_JSON',
        message: trimmed,
      },
    };
  }
}

const DANGEROUS_DESKTOP_BINARIES = new Set([
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'bash',
  'sh',
  'wscript',
  'wscript.exe',
  'cscript',
  'cscript.exe',
  'mshta',
  'mshta.exe',
  'rundll32',
  'rundll32.exe',
  'regsvr32',
  'regsvr32.exe',
  'certutil',
  'certutil.exe',
  'format',
  'format.com',
  'del',
  'rmdir',
]);

const FORBIDDEN_LAUNCH_PATTERN = /[&|;><$`\n\r\t\0\\/]/;

function validateLaunchAppName(appName: string): boolean {
  const trimmed = appName.trim().toLowerCase();
  if (!trimmed || FORBIDDEN_LAUNCH_PATTERN.test(trimmed)) {
    return false;
  }
  if (DANGEROUS_DESKTOP_BINARIES.has(trimmed)) {
    return false;
  }
  return true;
}

export class AgentDesktopProvider implements DesktopPort {
  private readonly executable: string;
  private readonly runCmd: AgentDesktopCommandRunner;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly defaultTimeoutMs: number;

  constructor(config: AgentDesktopConfig = {}) {
    this.env = config.env;
    this.executable = resolveAgentDesktopBinary(config.executablePath, this.env);
    this.runCmd = config.runCommand ?? defaultRunCommand;
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 30_000;
  }

  private async execute<T = unknown>(
    args: string[],
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<CliEnvelope<T>> {
    const result = await this.runCmd(this.executable, args, {
      env: this.env,
      timeoutMs: timeoutMs ?? this.defaultTimeoutMs,
      signal,
    });
    return parseJsonEnvelope<T>(result.stdout, result.stderr);
  }

  async status(signal?: AbortSignal): Promise<DesktopStatus> {
    const envelope = await this.execute<{
      platform?: string;
      version?: string;
      state_root?: string;
      permissions?: {
        accessibility?: { state?: string };
      };
    }>(['status'], signal);

    if (!envelope.ok || !envelope.data) {
      return {
        ok: false,
        platform: 'unknown',
        accessibility: 'unknown',
        interactiveSession: false,
        error: envelope.error?.message ?? 'Failed to get agent-desktop status',
      };
    }

    const data = envelope.data;
    const rawPlatform = data.platform ?? '';
    const platform: DesktopPlatform =
      rawPlatform === 'windows' || rawPlatform === 'macos' || rawPlatform === 'linux'
        ? rawPlatform
        : 'unknown';

    const rawAccess = data.permissions?.accessibility?.state ?? 'unknown';
    const accessibility: DesktopPermissionState =
      rawAccess === 'granted' || rawAccess === 'denied' || rawAccess === 'not_required'
        ? rawAccess
        : 'unknown';

    return {
      ok: true,
      platform,
      accessibility,
      interactiveSession: true,
      version: data.version,
      stateRoot: data.state_root,
    };
  }

  async listApps(signal?: AbortSignal): Promise<DesktopApp[]> {
    const envelope = await this.execute<
      Array<{ name?: string; bundle_id?: string; pid?: number }>
    >(['list-apps'], signal);

    if (!envelope.ok || !Array.isArray(envelope.data)) {
      if (envelope.error?.message?.includes('EnumWindows failed')) {
        return [];
      }
      return [];
    }

    return envelope.data.map((item) => ({
      name: item.name ?? 'unknown',
      bundleId: item.bundle_id,
      pid: item.pid,
    }));
  }

  async listWindows(app?: string, signal?: AbortSignal): Promise<DesktopWindow[]> {
    const args = ['list-windows'];
    if (app) {
      args.push('--app', app);
    }
    const envelope = await this.execute<
      Array<{
        id?: string;
        title?: string;
        app?: string;
        bounds?: { x: number; y: number; width: number; height: number };
        focused?: boolean;
      }>
    >(args, signal);

    if (!envelope.ok || !Array.isArray(envelope.data)) {
      return [];
    }

    return envelope.data.map((item, index) => ({
      id: item.id ?? String(index),
      title: item.title ?? '',
      app: item.app ?? app ?? 'unknown',
      bounds: item.bounds,
      focused: Boolean(item.focused),
    }));
  }

  async snapshot(
    options: DesktopSnapshotOptions = {},
    signal?: AbortSignal,
  ): Promise<DesktopSnapshotResult> {
    const args = ['snapshot'];
    if (options.app) args.push('--app', options.app);
    if (options.rootRef) args.push('--root', options.rootRef);
    if (options.interactiveOnly) args.push('-i');
    if (options.compact) args.push('--compact');
    if (options.skeleton) args.push('--skeleton');
    if (options.session) args.push('--session', options.session);

    const envelope = await this.execute<{
      snapshot_id?: string;
      tree?: DesktopNode;
    }>(args, signal, options.timeoutMs);

    if (!envelope.ok || !envelope.data) {
      return {
        ok: false,
        error: {
          code: envelope.error?.code ?? 'SNAPSHOT_FAILED',
          message: envelope.error?.message ?? 'Failed to capture desktop accessibility snapshot',
          retrySafe: envelope.error?.disposition?.retry === 'safe',
        },
      };
    }

    return {
      ok: true,
      snapshotId: envelope.data.snapshot_id,
      tree: envelope.data.tree,
      rawJson: JSON.stringify(envelope.data),
    };
  }

  async click(
    ref: string,
    options: DesktopActionOptions & { doubleClick?: boolean; rightClick?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<DesktopActionResult> {
    let subcommand = 'click';
    if (options.doubleClick) subcommand = 'double-click';
    else if (options.rightClick) subcommand = 'right-click';

    const args = [subcommand, ref];
    if (options.session) args.push('--session', options.session);
    if (options.headed || options.doubleClick) args.push('--headed');

    const envelope = await this.execute(args, signal, options.timeoutMs);
    if (!envelope.ok) {
      return {
        ok: false,
        action: subcommand,
        targetRef: ref,
        disposition: envelope.error?.disposition,
        error: {
          code: envelope.error?.code ?? 'CLICK_FAILED',
          message: envelope.error?.message ?? `Failed to perform ${subcommand} on ${ref}`,
          retrySafe: envelope.error?.disposition?.retry === 'safe',
        },
      };
    }

    return {
      ok: true,
      action: subcommand,
      targetRef: ref,
      disposition: { delivery: 'delivered', retry: 'safe' },
    };
  }

  async type(
    ref: string,
    text: string,
    options: DesktopActionOptions = {},
    signal?: AbortSignal,
  ): Promise<DesktopActionResult> {
    const args = ['type', ref, text];
    if (options.session) args.push('--session', options.session);
    if (options.headed) args.push('--headed');

    const envelope = await this.execute(args, signal, options.timeoutMs);
    if (!envelope.ok) {
      return {
        ok: false,
        action: 'type',
        targetRef: ref,
        disposition: envelope.error?.disposition,
        error: {
          code: envelope.error?.code ?? 'TYPE_FAILED',
          message: envelope.error?.message ?? `Failed to type text into ${ref}`,
          retrySafe: envelope.error?.disposition?.retry === 'safe',
        },
      };
    }

    return {
      ok: true,
      action: 'type',
      targetRef: ref,
      disposition: { delivery: 'delivered', retry: 'safe' },
    };
  }

  async press(
    keyCombo: string,
    options: DesktopActionOptions = {},
    signal?: AbortSignal,
  ): Promise<DesktopActionResult> {
    const args = ['press', keyCombo];
    if (options.session) args.push('--session', options.session);
    if (options.headed) args.push('--headed');

    const envelope = await this.execute(args, signal, options.timeoutMs);
    if (!envelope.ok) {
      return {
        ok: false,
        action: 'press',
        disposition: envelope.error?.disposition,
        error: {
          code: envelope.error?.code ?? 'PRESS_FAILED',
          message: envelope.error?.message ?? `Failed to send key combo ${keyCombo}`,
          retrySafe: envelope.error?.disposition?.retry === 'safe',
        },
      };
    }

    return {
      ok: true,
      action: 'press',
      disposition: { delivery: 'delivered', retry: 'safe' },
    };
  }

  async focusWindow(windowIdOrTitle: string, signal?: AbortSignal): Promise<DesktopActionResult> {
    const args = ['focus-window', windowIdOrTitle];
    const envelope = await this.execute(args, signal);
    if (!envelope.ok) {
      return {
        ok: false,
        action: 'focus-window',
        disposition: envelope.error?.disposition,
        error: {
          code: envelope.error?.code ?? 'FOCUS_WINDOW_FAILED',
          message: envelope.error?.message ?? `Failed to focus window: ${windowIdOrTitle}`,
          retrySafe: envelope.error?.disposition?.retry === 'safe',
        },
      };
    }

    return {
      ok: true,
      action: 'focus-window',
      disposition: { delivery: 'delivered', retry: 'safe' },
    };
  }

  async launch(appName: string, signal?: AbortSignal): Promise<DesktopActionResult> {
    if (!validateLaunchAppName(appName)) {
      return {
        ok: false,
        action: 'launch',
        disposition: { delivery: 'not_delivered', retry: 'terminal' },
        error: {
          code: 'POLICY_DENIED',
          message: `Application launch denied by security policy: ${appName}`,
          retrySafe: false,
        },
      };
    }
    const args = ['launch', appName];
    const envelope = await this.execute(args, signal);
    if (!envelope.ok) {
      return {
        ok: false,
        action: 'launch',
        disposition: envelope.error?.disposition,
        error: {
          code: envelope.error?.code ?? 'LAUNCH_FAILED',
          message: envelope.error?.message ?? `Failed to launch app: ${appName}`,
          retrySafe: envelope.error?.disposition?.retry === 'safe',
        },
      };
    }

    return {
      ok: true,
      action: 'launch',
      disposition: { delivery: 'delivered', retry: 'safe' },
    };
  }
}

export const createGhostDeskProvider = createAgentDesktopProvider;
export type GhostDeskConfig = AgentDesktopConfig;
export function createAgentDesktopProvider(config: AgentDesktopConfig = {}): DesktopPort {
  return new AgentDesktopProvider(config);
}
