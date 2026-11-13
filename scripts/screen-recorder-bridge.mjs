import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const PORT = 49152;
let ffmpegProcess = null;
let currentOutputFile = null;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  res.setHeader('Content-Type', 'application/json');

  if (url.pathname === '/status') {
    return res.end(JSON.stringify({ 
      recording: ffmpegProcess !== null,
      outputFile: currentOutputFile 
    }));
  }

  if (url.pathname === '/start') {
    if (ffmpegProcess) {
      return res.writeHead(400).end(JSON.stringify({ error: 'Recording already in progress' }));
    }
    const filename = url.searchParams.get('filename') || `demo_${Date.now()}.mp4`;
    const outDir = path.resolve(process.cwd(), 'docs/media');
    fs.mkdirSync(outDir, { recursive: true });
    currentOutputFile = path.join(outDir, filename);

    const fps = url.searchParams.get('fps') || '24';
    const duration = url.searchParams.get('duration');

    const args = [
      '-y',
      '-f', 'gdigrab',
      '-framerate', fps,
      '-i', 'desktop',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
    ];

    if (duration) {
      args.push('-t', duration);
    }
    args.push(currentOutputFile);

    console.log(`Starting screen recording: ${currentOutputFile}`);
    ffmpegProcess = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'inherit'] });

    ffmpegProcess.on('exit', (code) => {
      console.log(`ffmpeg finished with code ${code}`);
      ffmpegProcess = null;
    });

    return res.end(JSON.stringify({ 
      status: 'started',
      outputFile: currentOutputFile,
      fps,
      duration: duration || 'manual'
    }));
  }

  if (url.pathname === '/stop') {
    if (!ffmpegProcess) {
      return res.writeHead(400).end(JSON.stringify({ error: 'No active recording to stop' }));
    }
    console.log('Stopping recording gracefully (sending "q" to ffmpeg)...');
    try {
      ffmpegProcess.stdin.write('q');
    } catch {
      ffmpegProcess.kill('SIGINT');
    }
    const saved = currentOutputFile;
    return res.end(JSON.stringify({ 
      status: 'stopping',
      outputFile: saved 
    }));
  }

  res.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Apex Desktop Screen Recorder Bridge listening on http://127.0.0.1:${PORT}`);
  console.log(`Endpoint: http://127.0.0.1:${PORT}/start?filename=demo.mp4&duration=15`);
  console.log(`Endpoint: http://127.0.0.1:${PORT}/stop`);
  console.log(`Endpoint: http://127.0.0.1:${PORT}/status`);
});
