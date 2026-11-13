import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentDesktopProvider,
  createAgentDesktopProvider,
  type AgentDesktopCommandRunner,
} from '../src/providers/desktop/agent-desktop.ts';

test('status returns structured platform and accessibility info', async () => {
  const mockRunner: AgentDesktopCommandRunner = async (file, args) => {
    assert.deepEqual(args, ['status']);
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '2.6',
        ok: true,
        command: 'status',
        data: {
          platform: 'windows',
          version: '1.2.0',
          state_root: 'C:\\Users\\DELL\\.agent-desktop',
          permissions: {
            accessibility: { state: 'granted' },
          },
        },
      }),
      stderr: '',
    };
  };

  const provider = new AgentDesktopProvider({ runCommand: mockRunner });
  const status = await provider.status();

  assert.equal(status.ok, true);
  assert.equal(status.platform, 'windows');
  assert.equal(status.accessibility, 'granted');
  assert.equal(status.interactiveSession, true);
  assert.equal(status.version, '1.2.0');
});

test('status handles failure output gracefully', async () => {
  const mockRunner: AgentDesktopCommandRunner = async () => ({
    exitCode: 1,
    stdout: JSON.stringify({
      version: '2.6',
      ok: false,
      command: 'status',
      error: {
        code: 'PERM_DENIED',
        message: 'Accessibility permissions denied',
      },
    }),
    stderr: '',
  });

  const provider = new AgentDesktopProvider({ runCommand: mockRunner });
  const status = await provider.status();

  assert.equal(status.ok, false);
  assert.equal(status.interactiveSession, false);
  assert.equal(status.error, 'Accessibility permissions denied');
});

test('listApps parses running apps', async () => {
  const mockRunner: AgentDesktopCommandRunner = async (file, args) => {
    assert.deepEqual(args, ['list-apps']);
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '2.6',
        ok: true,
        command: 'list-apps',
        data: [
          { name: 'Spotify', bundle_id: 'com.spotify.client', pid: 1042 },
          { name: 'Slack', pid: 2048 },
        ],
      }),
      stderr: '',
    };
  };

  const provider = new AgentDesktopProvider({ runCommand: mockRunner });
  const apps = await provider.listApps();

  assert.equal(apps.length, 2);
  assert.equal(apps[0].name, 'Spotify');
  assert.equal(apps[0].bundleId, 'com.spotify.client');
  assert.equal(apps[0].pid, 1042);
  assert.equal(apps[1].name, 'Slack');
});

test('listApps recovers gracefully when EnumWindows fails in headless sessions', async () => {
  const mockRunner: AgentDesktopCommandRunner = async () => ({
    exitCode: 1,
    stdout: JSON.stringify({
      version: '2.6',
      ok: false,
      command: 'list-apps',
      error: {
        code: 'INTERNAL',
        message: 'EnumWindows failed to enumerate top-level windows',
        disposition: { delivery: 'not_delivered', retry: 'safe' },
      },
    }),
    stderr: '',
  });

  const provider = new AgentDesktopProvider({ runCommand: mockRunner });
  const apps = await provider.listApps();

  assert.deepEqual(apps, []);
});

test('listWindows includes app filter argument and maps windows', async () => {
  const mockRunner: AgentDesktopCommandRunner = async (file, args) => {
    assert.deepEqual(args, ['list-windows', '--app', 'Notepad']);
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '2.6',
        ok: true,
        command: 'list-windows',
        data: [
          {
            id: 'win-99',
            title: 'Untitled - Notepad',
            app: 'Notepad',
            bounds: { x: 100, y: 100, width: 800, height: 600 },
            focused: true,
          },
        ],
      }),
      stderr: '',
    };
  };

  const provider = new AgentDesktopProvider({ runCommand: mockRunner });
  const windows = await provider.listWindows('Notepad');

  assert.equal(windows.length, 1);
  assert.equal(windows[0].id, 'win-99');
  assert.equal(windows[0].title, 'Untitled - Notepad');
  assert.equal(windows[0].focused, true);
  assert.equal(windows[0].bounds?.width, 800);
});

test('snapshot passes formatting flags and returns accessibility tree', async () => {
  const mockRunner: AgentDesktopCommandRunner = async (file, args) => {
    assert.deepEqual(args, [
      'snapshot',
      '--app',
      'Slack',
      '--root',
      '@s8f3k2p9:e1',
      '-i',
      '--compact',
      '--skeleton',
      '--session',
      'sess-test',
    ]);
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '2.6',
        ok: true,
        command: 'snapshot',
        data: {
          snapshot_id: 'snap-123',
          tree: {
            ref: '@s8f3k2p9:e1',
            role: 'window',
            name: 'Slack Main',
            children: [
              {
                ref: '@s8f3k2p9:e2',
                role: 'button',
                name: 'Send Message',
              },
            ],
          },
        },
      }),
      stderr: '',
    };
  };

  const provider = new AgentDesktopProvider({ runCommand: mockRunner });
  const result = await provider.snapshot({
    app: 'Slack',
    rootRef: '@s8f3k2p9:e1',
    interactiveOnly: true,
    compact: true,
    skeleton: true,
    session: 'sess-test',
  });

  assert.equal(result.ok, true);
  assert.equal(result.snapshotId, 'snap-123');
  assert.equal(result.tree?.ref, '@s8f3k2p9:e1');
  assert.equal(result.tree?.children?.[0].role, 'button');
});

test('actions construct proper CLI arguments for click, type, press, focus, and launch', async () => {
  const recordedCommands: string[][] = [];

  const mockRunner: AgentDesktopCommandRunner = async (file, args) => {
    recordedCommands.push([...args]);
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        version: '2.6',
        ok: true,
        command: args[0],
        data: { disposition: { delivery: 'delivered', retry: 'safe' } },
      }),
      stderr: '',
    };
  };

  const provider = createAgentDesktopProvider({ runCommand: mockRunner });

  const clickRes = await provider.click('@s8f3:e1', { doubleClick: true, session: 's1' });
  assert.equal(clickRes.ok, true);
  assert.equal(clickRes.action, 'double-click');

  const typeRes = await provider.type('@s8f3:e2', 'hello world', { headed: true });
  assert.equal(typeRes.ok, true);

  const pressRes = await provider.press('ctrl+s');
  assert.equal(pressRes.ok, true);

  const focusRes = await provider.focusWindow('win-1');
  assert.equal(focusRes.ok, true);

  const launchRes = await provider.launch('calc.exe');
  assert.equal(launchRes.ok, true);

  assert.deepEqual(recordedCommands, [
    ['double-click', '@s8f3:e1', '--session', 's1', '--headed'],
    ['type', '@s8f3:e2', 'hello world', '--headed'],
    ['press', 'ctrl+s'],
    ['focus-window', 'win-1'],
    ['launch', 'calc.exe'],
  ]);
});

test('launch blocks dangerous binaries and shell metacharacters by policy', async () => {
  const provider = createAgentDesktopProvider();

  const cmdRes = await provider.launch('cmd.exe');
  assert.equal(cmdRes.ok, false);
  assert.equal(cmdRes.error?.code, 'POLICY_DENIED');

  const psRes = await provider.launch('powershell');
  assert.equal(psRes.ok, false);
  assert.equal(psRes.error?.code, 'POLICY_DENIED');

  const injectRes = await provider.launch('calc.exe | dir');
  assert.equal(injectRes.ok, false);
  assert.equal(injectRes.error?.code, 'POLICY_DENIED');
});

test('live status executes real agent-desktop executable on local system', async () => {
  const provider = createAgentDesktopProvider();
  const status = await provider.status();
  assert.equal(typeof status.ok, 'boolean');
  if (status.ok) {
    assert.equal(status.platform, 'windows');
    assert.equal(status.accessibility, 'granted');
  }
});
