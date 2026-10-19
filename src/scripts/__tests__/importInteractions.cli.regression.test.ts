/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(path.join(__dirname, '../importInteractions.ts'), 'utf8');
const cliSource = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;

async function runStandalone(csv: string | null, fail?: 'exists' | 'close') {
  const state = { opens: 0, closes: 0, inserted: 0, errors: 0, dbPath: '' };
  const fakeProcess = { cwd: () => 'synthetic-workdir', exitCode: 0 };
  const fakeDb = class {
    constructor(dbPath: string) {
      state.opens++;
      state.dbPath = dbPath;
    }
    exec() {}
    prepare() {
      return { run: () => { state.inserted++; } };
    }
    transaction(callback: (rows: unknown[]) => void) {
      return (rows: unknown[]) => callback(rows);
    }
    close() {
      state.closes++;
      if (fail === 'close') throw new Error('Synthetic close failure');
    }
  };
  const entry = { exports: {} };
  const modules: Record<string, unknown> = {
    fs: {
      existsSync: () => {
        if (fail === 'exists') throw new Error('Synthetic file check failure');
        return csv !== null;
      },
      readFileSync: () => {
        if (csv === null) throw new Error('Unexpected CSV read');
        return csv;
      },
    },
    path,
    'better-sqlite3': fakeDb,
    'csv-parse/sync': require('csv-parse/sync'),
  };
  const fakeRequire = Object.assign(
    (name: string) => {
      if (!(name in modules)) throw new Error(`Unexpected module: ${name}`);
      return modules[name];
    },
    { main: entry },
  );
  vm.runInNewContext(cliSource, {
    module: entry,
    exports: entry.exports,
    require: fakeRequire,
    process: fakeProcess,
    console: { log() {}, warn() {}, error() { state.errors++; } },
  }, { filename: 'importInteractions.synthetic-cli.js' });
  await new Promise<void>(resolve => setImmediate(resolve));
  return { ...state, exitCode: fakeProcess.exitCode };
}

describe('standalone interaction importer CLI (synthetic database only)', () => {
  it('exits nonzero and closes the database when the CSV is missing', async () => {
    const state = await runStandalone(null);
    expect(state.exitCode).toBe(1);
    expect(state.opens).toBe(1);
    expect(state.closes).toBe(1);
    expect(state.inserted).toBe(0);
    expect(state.dbPath).toBe(path.join('synthetic-workdir', 'pharma_local.db'));
  });

  it('exits successfully and closes the database after a valid import', async () => {
    const state = await runStandalone('Drug 1,Drug 2,Interaction Description\nING-A,ING-B,description\n');
    expect(state.exitCode).toBe(0);
    expect(state.opens).toBe(1);
    expect(state.closes).toBe(1);
    expect(state.inserted).toBe(2); // DELETE and INSERT both use prepared statements
  });

  it('closes the database and exits nonzero after an unexpected import rejection', async () => {
    const state = await runStandalone(null, 'exists');
    expect(state.exitCode).toBe(1);
    expect(state.opens).toBe(1);
    expect(state.closes).toBe(1);
    expect(state.errors).toBe(1);
  });

  it('exits nonzero if database closing fails after a successful import', async () => {
    const state = await runStandalone('Drug 1,Drug 2,Interaction Description\nING-A,ING-B,description\n', 'close');
    expect(state.exitCode).toBe(1);
    expect(state.closes).toBe(1);
    expect(state.errors).toBe(1);
  });
});
