import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const browserPath = process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const htmlPath = resolve('docs/media/apex-demo.html');
const outputFile = resolve('docs/media/apex-demo.mp4');

const profile = await mkdtemp(join(tmpdir(), 'apex-recorder-'));
let edge;
let socket;

try {
  console.log('Spawning Edge headless for deterministic rendering...');
  edge = spawn(browserPath, [
    '--headless=new',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank'
  ], { stdio: 'ignore' });

  await once(edge, 'spawn');
  let port;
  for (let i = 0; i < 50; i++) {
    try {
      port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
      break;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  assert(port, 'Failed to acquire Edge DevTools port');
  console.log(`Connected to Edge CDP on port ${port}`);

  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const targetPage = pages.find(p => p.type === 'page');
  assert(targetPage, 'Target page not found');

  socket = new WebSocket(targetPage.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });

  let id = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
    }
  };

  const send = (method, params = {}) => {
    const current = ++id;
    return new Promise((resolve, reject) => {
      pending.set(current, resolve);
      socket.send(JSON.stringify({ id: current, method, params }));
    });
  };

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    return res.result?.result?.value;
  };

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false
  });

  const fileUrl = pathToFileURL(htmlPath).href;
  await send('Page.navigate', { url: fileUrl });

  for (let i = 0; i < 50; i++) {
    if (await evaluate('window.mediaReady === true')) break;
    await new Promise(r => setTimeout(r, 100));
  }

  const fps = 24;
  const durationSeconds = 11;
  const totalFrames = fps * durationSeconds;

  console.log(`Starting FFmpeg video stream to: ${outputFile}`);
  const ffmpeg = spawn('ffmpeg', [
    '-y',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-framerate', String(fps),
    '-i', '-',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    outputFile
  ], { stdio: ['pipe', 'inherit', 'inherit'] });

  console.log(`Rendering and encoding ${totalFrames} frames...`);
  for (let f = 0; f < totalFrames; f++) {
    const t = f / fps;
    await evaluate(`window.renderAt(${t.toFixed(3)})`);
    const screenshot = await send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 92
    });
    const buffer = Buffer.from(screenshot.result.data, 'base64');
    ffmpeg.stdin.write(buffer);

    if (f % (fps * 2) === 0) {
      console.log(`Rendered frame ${f}/${totalFrames} (${t.toFixed(1)}s)...`);
    }
  }

  ffmpeg.stdin.end();
  await once(ffmpeg, 'close');
  console.log(`Successfully generated Apex demo video: ${outputFile}`);
} finally {
  socket?.close();
  edge?.kill();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
