const { renameSync, existsSync, cpSync, rmSync } = require('fs');
const { execSync } = require('child_process');
const { join } = require('path');

const apiPath = join(__dirname, '../src/app/api');
const tempApiPath = join(__dirname, '../api_temp');

const actionsPath = join(__dirname, '../src/app/actions');
const tempActionsPath = join(__dirname, '../actions_temp');
const middlewarePath = join(__dirname, '../src/middleware.ts');
const tempMiddlewarePath = join(__dirname, '../middleware_temp.ts');

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

let middlewareRenamed = false;
if (existsSync(middlewarePath)) {
  console.log('Temporarily moving middleware for static Tauri export...');
  renameSync(middlewarePath, tempMiddlewarePath);
  middlewareRenamed = true;
}

try {
  console.log('Running Next.js static build for Tauri...');
  execSync('npx cross-env TAURI_BUILD=1 NEXT_PUBLIC_TAURI=1 PHARMA_DB_PATH=pharma_local.db next build', { stdio: 'inherit' });
} catch (error) {
  console.error('Build failed:', error);
  process.exitCode = 1;
} finally {
  if (middlewareRenamed && existsSync(tempMiddlewarePath)) {
    console.log('Restoring middleware to src/middleware.ts...');
    renameSync(tempMiddlewarePath, middlewarePath);
  }
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
