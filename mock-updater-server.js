const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const BUNDLE_DIR = path.join(__dirname, 'src-tauri', 'target', 'release', 'bundle', 'nsis');

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  console.log(`[Mock Server] Received request for: ${req.url}`);

  if (req.url === '/latest.json') {
    // Find the latest zip and sig in the bundle dir
    let zipFile = null;
    let sigFile = null;
    try {
      const files = fs.readdirSync(BUNDLE_DIR);
      zipFile = files.find(f => f.endsWith('.zip'));
      sigFile = files.find(f => f.endsWith('.zip.sig'));
    } catch (err) {
      console.error('Error reading bundle directory:', err);
    }

    if (!zipFile || !sigFile) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Updater artifacts not found. Wait for build to finish.' }));
      return;
    }

    const signature = fs.readFileSync(path.join(BUNDLE_DIR, sigFile), 'utf-8');

    const latestJson = {
      version: "0.2.7", // Bump version to trigger update
      notes: "Test update for the updater button.",
      pub_date: new Date().toISOString(),
      platforms: {
        "windows-x86_64": {
          signature: signature,
          url: `http://localhost:${PORT}/${zipFile}`
        }
      }
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(latestJson, null, 2));
    return;
  }

  if (req.url.endsWith('.zip')) {
    const filePath = path.join(BUNDLE_DIR, decodeURIComponent(req.url.slice(1)));
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`[Mock Server] Updater running at http://localhost:${PORT}`);
  console.log(`Serving from: ${BUNDLE_DIR}`);
});
