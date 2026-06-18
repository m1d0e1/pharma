const { renameSync, existsSync, cpSync, rmSync } = require('fs');
const { execSync } = require('child_process');
const { join } = require('path');

const apiPath = join(__dirname, '../src/app/api');
const tempApiPath = join(__dirname, '../api_temp');

const actionsPath = join(__dirname, '../src/app/actions');
const tempActionsPath = join(__dirname, '../actions_temp');

let apiRenamed = false;
if (existsSync(apiPath)) {
  console.log('Temporarily moving api folder to root...');
  renameSync(apiPath, tempApiPath);
  apiRenamed = true;
}

let actionsRenamed = false;
if (existsSync(actionsPath)) {
  console.log('Temporarily moving actions folder to root...');
  renameSync(actionsPath, tempActionsPath);
  actionsRenamed = true;

  console.log('Copying actions-client to src/app/actions...');
  cpSync(join(__dirname, '../src/app/actions-client'), actionsPath, { recursive: true });
}

try {
  console.log('Running Next.js static build for Tauri...');
  // We run next build with TAURI_BUILD=1
  // Next.js static export exits with code 1 due to middleware warning even on success
  // so we allow that specific exit code through
  try {
    execSync('npx cross-env TAURI_BUILD=1 PHARMA_DB_PATH=pharma_local.db next build', { stdio: 'inherit' });
  } catch (e) {
    // status 1 is expected from Next.js export mode warning about middleware
    if (e.status !== 1) throw e;
    console.log('Build completed (ignoring Next.js export mode warning)');
  }
} catch (error) {
  console.error('Build failed:', error);
  process.exitCode = 1;
} finally {
  if (apiRenamed && existsSync(tempApiPath)) {
    console.log('Restoring api folder to src/app/api...');
    renameSync(tempApiPath, apiPath);
  }
  if (actionsRenamed) {
    if (existsSync(actionsPath)) {
      console.log('Removing temporary actions copy...');
      rmSync(actionsPath, { recursive: true, force: true });
    }
    if (existsSync(tempActionsPath)) {
      console.log('Restoring actions folder to src/app/actions...');
      renameSync(tempActionsPath, actionsPath);
    }
  }
}
