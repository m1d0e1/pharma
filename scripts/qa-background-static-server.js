#!/usr/bin/env node
'use strict';

// Isolated, loopback-only static Tauri export server. Never run Next dev/build
// concurrently with Jest and never modify the working tree or protected DB.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = fs.realpathSync(path.resolve(__dirname, '../out'));
const port = Number(process.argv.find(arg => arg.startsWith('--port='))?.slice(7) || 3118);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid loopback QA port');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
  '.txt': 'text/plain', '.map': 'application/json' };

http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); return res.end();
  }
  let requested;
  try { requested = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); }
  catch { res.writeHead(400); return res.end(); }
  if (requested.includes('\0') || requested.includes('\\')) {
    res.writeHead(400); return res.end();
  }
  const candidate = path.resolve(root, '.' + requested);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    res.writeHead(403); return res.end();
  }
  const candidates = [candidate, candidate + '.html', path.join(candidate, 'index.html')];
  const file = candidates.find(item => {
    try { return fs.statSync(item).isFile() && fs.realpathSync(item).startsWith(root + path.sep); }
    catch { return false; }
  });
  if (!file) { res.writeHead(404); return res.end('Not found'); }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': (types[ext] || 'application/octet-stream') + (['.html','.js','.css','.json','.txt'].includes(ext) ? '; charset=utf-8' : ''),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`Synthetic Tauri export served at http://127.0.0.1:${port}`));
