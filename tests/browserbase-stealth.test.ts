import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserActionError } from '../src/ports/computer.ts';
import {
  buildBrowseArgs,
  createBrowserbaseCliProvider,
  detectAntiBotChallenge,
  type BrowseCommandResult,
} from '../src/providers/browserbase/client.ts';

interface RecordedCall {
  file: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
}

function createMockRunner(
  handler: (
    file: string,
    args: readonly string[],
    options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal },
  ) => BrowseCommandResult | Promise<BrowseCommandResult>,
) {
  const calls: RecordedCall[] = [];
  const runCommand = async (
    file: string,
    args: readonly string[],
    options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<BrowseCommandResult> => {
    calls.push({ file, args: [...args], env: options?.env });
    return handler(file, args, options);
  };
  return { calls, runCommand };
}

test('buildBrowseArgs constructs safe CLI arguments for local and remote modes', () => {
  assert.deepEqual(buildBrowseArgs('snapshot'), ['snapshot', '--session', 'default', '--local']);

  assert.deepEqual(
    buildBrowseArgs(['open', 'https://example.com/search?q=a&b=1'], {
      session: 'worker-1',
      mode: 'local',
      verified: true,
      proxies: true,
    }),
    ['open', 'https://example.com/search?q=a&b=1', '--session', 'worker-1', '--local'],
  );

  assert.deepEqual(
    buildBrowseArgs(['open', 'https://protected.example'], {
      session: 'worker-2',
      mode: 'remote',
      verified: true,
      proxies: true,
    }),
    [
      'open',
      'https://protected.example',
      '--session',
      'worker-2',
      '--remote',
      '--verified',
      '--proxies',
    ],
  );

  assert.deepEqual(
    buildBrowseArgs(['fill', '@e3', 'hello; rm -rf /'], {
      session: 'worker-3',
      mode: 'remote',
    }),
    ['fill', '@e3', 'hello; rm -rf /', '--session', 'worker-3', '--remote'],
  );

  assert.throws(() => buildBrowseArgs([]), /must not be empty/i);
  assert.throws(
    () => buildBrowseArgs('snapshot', { session: 'bad session' }),
    /Invalid stealth browser session name/i,
  );
  assert.throws(
    () => buildBrowseArgs('snapshot', { session: '-flag' }),
    /Invalid stealth browser session name/i,
  );
});

test('detectAntiBotChallenge classifies Cloudflare, CAPTCHA, bot walls, and clean pages', () => {
  assert.deepEqual(
    detectAntiBotChallenge(
      'Checking your browser before accessing cf-turnstile',
      'Just a moment...',
    ),
    { challenge: 'cloudflare', escalateToRemote: true },
  );

  assert.deepEqual(
    detectAntiBotChallenge('Please Verify you are human to continue', 'Security Check'),
    { challenge: 'captcha', escalateToRemote: true },
  );

  assert.deepEqual(
    detectAntiBotChallenge('Solve the reCAPTCHA widget below', 'Human Verification'),
    { challenge: 'captcha', escalateToRemote: true },
  );

  assert.deepEqual(
    detectAntiBotChallenge(
      'Access Denied: You do not have permission to view this page',
      '403 Forbidden',
    ),
    { challenge: 'bot_block', escalateToRemote: true },
  );

  assert.deepEqual(
    detectAntiBotChallenge(
      'Welcome to Example Domain. Sign in or browse catalog.',
      'Example Domain',
    ),
    { challenge: 'none', escalateToRemote: false },
  );
});

test('createBrowserbaseCliProvider dispatches open, snapshot, click, fill, title, stop, and doctor', async () => {
  const { calls, runCommand } = createMockRunner((_file, args) => {
    const command = args[0];
    if (command === 'open') {
      return {
        stdout: JSON.stringify({
          url: args[1],
          title: 'Login Page',
          text: 'heading "Sign in" [ref=e1]',
        }),
        stderr: '',
        exitCode: 0,
      };
    }
    if (command === 'snapshot') {
      return {
        stdout: 'textbox "Email" [ref=e2]\nbutton "Submit" [ref=e3]',
        stderr: '',
        exitCode: 0,
      };
    }
    if (command === 'fill') {
      return { stdout: 'Filled @e2', stderr: '', exitCode: 0 };
    }
    if (command === 'click') {
      return { stdout: 'Clicked @e3', stderr: '', exitCode: 0 };
    }
    if (command === 'get' && args[1] === 'title') {
      return { stdout: 'Dashboard\n', stderr: '', exitCode: 0 };
    }
    if (command === 'doctor') {
      return { stdout: 'browse ok\n', stderr: '', exitCode: 0 };
    }
    return { stdout: 'stopped', stderr: '', exitCode: 0 };
  });

  const provider = createBrowserbaseCliProvider({
    apiKey: 'bb_test_secret_key',
    chromePath: '/usr/bin/google-chrome',
    runCommand,
  });

  const openResult = await provider.executeAction(
    { action: 'open', url: 'https://app.example/login' },
    { session: 'task-1' },
  );
  assert.equal(openResult.observation.url, 'https://app.example/login');
  assert.equal(openResult.observation.text, 'heading "Sign in" [ref=e1]');
  assert.equal(openResult.title, 'Login Page');
  assert.equal(openResult.challenge, 'none');
  assert.equal(openResult.mode, 'local');

  const snapshotResult = await provider.executeAction(
    { action: 'snapshot' },
    { session: 'task-1' },
  );
  assert.equal(snapshotResult.observation.url, 'https://app.example/login');
  assert.match(snapshotResult.observation.text, /button "Submit"/);

  const fillResult = await provider.executeAction(
    { action: 'fill', selector: '@e2', text: 'alice@example.com' },
    { session: 'task-1' },
  );
  assert.equal(fillResult.observation.text, 'Filled @e2');

  const clickResult = await provider.executeAction(
    { action: 'click', selector: '@e3' },
    { session: 'task-1' },
  );
  assert.equal(clickResult.observation.text, 'Clicked @e3');

  const pageTitle = await provider.title({ session: 'task-1' });
  assert.equal(pageTitle, 'Dashboard');

  const doctor = await provider.doctor({ session: 'task-1' });
  assert.equal(doctor.ok, true);
  assert.equal(doctor.remoteAvailable, true);
  assert.equal(doctor.chromePath, '/usr/bin/google-chrome');

  await provider.stop({ session: 'task-1' });

  assert.deepEqual(
    calls.map((c) => c.args),
    [
      ['open', 'https://app.example/login', '--session', 'task-1', '--local'],
      ['snapshot', '--session', 'task-1', '--local'],
      ['fill', '@e2', 'alice@example.com', '--session', 'task-1', '--local'],
      ['click', '@e3', '--session', 'task-1', '--local'],
      ['get', 'title', '--session', 'task-1', '--local'],
      ['doctor', '--session', 'task-1', '--local'],
      ['stop', '--session', 'task-1', '--local'],
    ],
  );
  assert.equal(calls[0]?.env?.CHROME_PATH, '/usr/bin/google-chrome');
  assert.equal(calls[0]?.env?.BROWSERBASE_API_KEY, 'bb_test_secret_key');
  for (const call of calls) {
    assert.equal(call.args.includes('bb_test_secret_key'), false);
  }
});

test('createBrowserbaseCliProvider isolates sessions independently', async () => {
  const { calls, runCommand } = createMockRunner((_file, args) => {
    const isRemote = args.includes('--remote');
    const command = args[0];
    const sessionIndex = args.indexOf('--session');
    const session = sessionIndex >= 0 ? args[sessionIndex + 1] : 'default';
    if (command === 'open') {
      const targetUrl = args[1];
      if (session === 'alpha' && !isRemote) {
        return {
          stdout: 'Just a moment... cf-turnstile challenge',
          stderr: '',
          exitCode: 0,
        };
      }
      return {
        stdout: `Loaded ${targetUrl}`,
        stderr: '',
        exitCode: 0,
      };
    }
    return {
      stdout: `Snapshot for ${session}`,
      stderr: '',
      exitCode: 0,
    };
  });

  const provider = createBrowserbaseCliProvider({
    apiKey: 'bb_live_key',
    runCommand,
  });

  const alphaOpen = await provider.open('https://protected.example', { session: 'alpha' });
  assert.equal(alphaOpen.mode, 'remote');
  assert.equal(alphaOpen.escalated, true);

  const betaOpen = await provider.open('https://public.example', { session: 'beta' });
  assert.equal(betaOpen.mode, 'local');
  assert.equal(betaOpen.escalated, false);
  assert.equal(betaOpen.observation.url, 'https://public.example');

  const alphaSnapshot = await provider.snapshot({ session: 'alpha' });
  assert.equal(alphaSnapshot.mode, 'remote');
  assert.equal(alphaSnapshot.observation.url, 'https://protected.example');

  const betaSnapshot = await provider.snapshot({ session: 'beta' });
  assert.equal(betaSnapshot.mode, 'local');
  assert.equal(betaSnapshot.observation.url, 'https://public.example');

  assert.deepEqual(
    calls.map((c) => c.args),
    [
      ['open', 'https://protected.example', '--session', 'alpha', '--local'],
      [
        'open',
        'https://protected.example',
        '--session',
        'alpha',
        '--remote',
        '--verified',
        '--proxies',
      ],
      ['open', 'https://public.example', '--session', 'beta', '--local'],
      ['snapshot', '--session', 'alpha', '--remote', '--verified', '--proxies'],
      ['snapshot', '--session', 'beta', '--local'],
    ],
  );
});

test('createBrowserbaseCliProvider escalates local anti-bot challenges when apiKey is present and reports without apiKey', async () => {
  const withKey = createMockRunner((_file, args) => {
    if (args.includes('--local')) {
      return {
        stdout: JSON.stringify({
          url: 'https://target.example',
          title: 'Just a moment...',
          text: 'Cloudflare Turnstile verification',
        }),
        stderr: '',
        exitCode: 0,
      };
    }
    return {
      stdout: JSON.stringify({
        url: 'https://target.example/home',
        title: 'Target Home',
        text: 'Welcome aboard',
      }),
      stderr: '',
      exitCode: 0,
    };
  });

  const providerWithKey = createBrowserbaseCliProvider({
    apiKey: 'bb_key_123',
    runCommand: withKey.runCommand,
  });

  const escalated = await providerWithKey.open('https://target.example', { session: 'esc-1' });
  assert.equal(escalated.escalated, true);
  assert.equal(escalated.escalatedFromChallenge, 'cloudflare');
  assert.equal(escalated.challenge, 'none');
  assert.equal(escalated.escalateToRemote, false);
  assert.equal(escalated.mode, 'remote');
  assert.equal(escalated.observation.text, 'Welcome aboard');
  assert.match(escalated.escalationReason ?? '', /--verified --proxies/);

  const withoutKey = createMockRunner(() => ({
    stdout: 'Verify you are human before continuing',
    stderr: '',
    exitCode: 0,
  }));

  const providerWithoutKey = createBrowserbaseCliProvider({
    runCommand: withoutKey.runCommand,
  });

  const localBlocked = await providerWithoutKey.open('https://target.example', {
    session: 'esc-2',
  });
  assert.equal(localBlocked.mode, 'local');
  assert.equal(localBlocked.challenge, 'captcha');
  assert.equal(localBlocked.escalateToRemote, true);
  assert.equal(localBlocked.escalated, false);
  assert.match(localBlocked.escalationReason ?? '', /API key required/i);
  assert.equal(withoutKey.calls.length, 1);

  const manualProvider = createBrowserbaseCliProvider({
    apiKey: 'bb_key_123',
    autoEscalate: false,
    runCommand: withoutKey.runCommand,
  });
  const reportedOnly = await manualProvider.open('https://target.example', { session: 'esc-3' });
  assert.equal(reportedOnly.mode, 'local');
  assert.equal(reportedOnly.challenge, 'captcha');
  assert.equal(reportedOnly.escalateToRemote, true);
  assert.equal(reportedOnly.escalated, false);
  assert.match(reportedOnly.escalationReason ?? '', /--remote --verified --proxies/);
});

test('createBrowserbaseCliProvider surfaces BrowserActionError and handles doctor failures', async () => {
  const { runCommand } = createMockRunner((_file, args) => {
    if (args.includes('doctor')) {
      throw new Error('spawn browse ENOENT');
    }
    return { stdout: '', stderr: 'Element not found', exitCode: 1 };
  });

  const provider = createBrowserbaseCliProvider({ runCommand });

  await assert.rejects(
    () => provider.executeAction({ action: 'click' }),
    (err: unknown) => err instanceof BrowserActionError && err.code === 'browser_action_failed',
  );

  await assert.rejects(
    () => provider.executeAction({ action: 'fill', selector: '@e1' }),
    (err: unknown) => err instanceof BrowserActionError && err.code === 'browser_action_failed',
  );

  await assert.rejects(
    () => provider.open('https://down.example'),
    (err: unknown) => err instanceof BrowserActionError && err.code === 'browser_navigation_failed',
  );

  const doctor = await provider.doctor();
  assert.equal(doctor.ok, false);
  assert.equal(doctor.remoteAvailable, false);
  assert.match(doctor.output, /ENOENT/);
});
