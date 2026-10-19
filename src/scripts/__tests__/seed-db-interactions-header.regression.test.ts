/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const scriptDir = path.resolve(__dirname, '../../../scripts');
const seedSource = fs.readFileSync(path.join(scriptDir, 'seed-db.js'), 'utf8');

function dryRun(interactionsCsv: string | null) {
  const files = new Map<string, string>([
    ['egypt_drugs_smart_scrape.csv', 'id,Trade Name,Price,Active Ingredient,Category,Manufacturer\n1,Sample,10,Ingredient,Drug,Maker\n'],
    ['egypt_drugs_drugeye.csv', 'Trade Name,Price,Active Ingredient,Category,Manufacturer\nSample,10,Ingredient,Drug,Maker\n'],
  ]);
  if (interactionsCsv !== null) files.set('db_drug_interactions.csv', interactionsCsv);
  const prohibitWrites = () => { throw new Error('Dry-run attempted a filesystem or database write'); };
  const mockFs = {
    existsSync: (filename: string) => files.has(path.basename(filename)),
    readFileSync: (filename: string) => {
      const content = files.get(path.basename(filename));
      if (content === undefined) throw new Error(`Unexpected file read: ${filename}`);
      return content;
    },
    mkdirSync: prohibitWrites,
    rmSync: prohibitWrites,
    renameSync: prohibitWrites,
  };
  let exitCode: number | undefined;
  const done = {};
  const modules: Record<string, unknown> = {
    fs: mockFs,
    path,
    'better-sqlite3': class { constructor() { prohibitWrites(); } },
    'csv-parse/sync': require('csv-parse/sync'),
    './catalog-reference': {
      loadReference: () => [['Sample', '10', 'Ingredient', 'Drug', 'Maker']],
      installReference: prohibitWrites,
    },
  };
  try {
    vm.runInNewContext(seedSource, {
      __dirname: scriptDir,
      require: (id: string) => modules[id] || (() => { throw new Error(`Unexpected module: ${id}`); })(),
      console: { log: () => undefined, warn: () => undefined },
      process: {
        argv: ['node', 'seed-db.js', '--dry-run'],
        stdout: { write: prohibitWrites },
        exit: (code: number) => { exitCode = code; throw done; },
      },
    }, { filename: 'seed-db.js' });
  } catch (error) {
    if (error !== done) throw error;
  }
  return exitCode;
}

describe('seed-db interaction CSV headers (mocked dry run)', () => {
  it.each([
    ['reordered columns', 'Drug 2,Drug 1,Interaction Description\nAspirin,Warfarin,description\n'],
    ['injected extra column', '__proto__,Drug 1,Drug 2,Interaction Description\nforged,Warfarin,Aspirin,description\n'],
    ['empty file', ''],
  ])('rejects %s before any database access', (_label, csv) => {
    expect(() => dryRun(csv)).toThrow('db_drug_interactions.csv columns must be exactly: Drug 1, Drug 2, Interaction Description');
  });

  it('accepts exact columns with a UTF-8 BOM', () => {
    expect(dryRun('\ufeffDrug 1,Drug 2,Interaction Description\nWarfarin,Aspirin,description\n')).toBe(0);
  });

  it('preserves the existing optional missing-interactions-CSV dry-run behavior', () => {
    expect(dryRun(null)).toBe(0);
  });
});
