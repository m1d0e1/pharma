'use strict';

// Both the static Tauri exporter and the background Jest harness access the
// *same* src/middleware.ts and src/app/actions paths. Static export renames
// those paths, so overlapping QA/builds produce spurious failures or exercise
// the wrong implementation. This is advisory process coordination, NOT a
// business database or authorization lock.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function lockPathFor(root, tempRoot = os.tmpdir()) {
  const canonicalRoot = fs.realpathSync(root);
  const canonicalTemp = fs.realpathSync(tempRoot);
  if (canonicalRoot.toLowerCase() === canonicalTemp.toLowerCase()
      || canonicalTemp.toLowerCase().startsWith(canonicalRoot.toLowerCase() + path.sep)) {
    throw new Error('QA/build coordination TEMP must be outside the repository');
  }
  const digest = crypto.createHash('sha256')
    .update(process.platform === 'win32' ? canonicalRoot.toLowerCase() : canonicalRoot)
    .digest('hex').slice(0, 24);
  return path.join(canonicalTemp, 'pharma-qa-build-' + digest + '.lock');
}

function acquireWorkspaceExclusive(root, label, tempRoot = os.tmpdir()) {
  if (!['qa:background', 'build:tauri'].includes(label)) {
    throw new Error('Unknown QA/build coordination participant');
  }
  const filename = lockPathFor(root, tempRoot);
  let fd;
  const owner = JSON.stringify({
    label, pid: process.pid, at: new Date().toISOString(),
    token: crypto.randomBytes(16).toString('hex'),
  });
  try {
    // Exclusive create is atomic even across separate Windows node processes.
    // Do not auto-delete an existing lock: an owner may still be mid-export.
    fd = fs.openSync(filename, 'wx', 0o600);
    fs.writeSync(fd, owner);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (error.code === 'EEXIST') {
      throw new Error('QA/build overlap refused: existing workspace coordination lock at '
        + filename + '; wait for its owner to finish or investigate a stale lock before any manual removal');
    }
    throw error;
  }
  fs.closeSync(fd);
  let released = false;
  return function release() {
    if (released) return;
    // This closure alone owns the successful exclusive create. Never delete
    // someone else's lock after replacement or tampering.
    const onDisk = fs.readFileSync(filename, 'utf8');
    if (onDisk !== owner) {
      throw new Error('QA/build coordination owner changed; refusing to remove lock');
    }
    fs.unlinkSync(filename);
    released = true;
  };
}

module.exports = { lockPathFor, acquireWorkspaceExclusive };
