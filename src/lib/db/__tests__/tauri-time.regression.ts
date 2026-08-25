import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { normalizeDatabaseTimestamps } from '../tauri';

it('keeps new-window database initialization non-blocking and process-scoped', () => {
  const databaseClient = readFileSync(join(process.cwd(), 'src/lib/db/tauri.ts'), 'utf8');
  const nativeStartup = readFileSync(join(process.cwd(), 'src-tauri/src/main.rs'), 'utf8');
  const masterDrugActions = readFileSync(join(process.cwd(), 'src/app/actions-client/master-drugs.ts'), 'utf8');
  const inventorySearch = masterDrugActions.slice(
    masterDrugActions.indexOf('export async function searchInventoryAction'),
    masterDrugActions.indexOf('export async function', masterDrugActions.indexOf('export async function searchInventoryAction') + 1)
  );

  expect(nativeStartup).toContain('schema::prepare_legacy_database(&db_path)');
  expect(databaseClient).not.toMatch(/invoke\(['"]ensure_schema_compatibility['"]\)/);
  expect(inventorySearch).toContain('await secureCache.load();');
});

it('does not copy large query results that have no timestamp columns', () => {
  const rows = [{ id: 1, trade_name: 'Test drug', quantity: 2 }];
  expect(normalizeDatabaseTimestamps(rows)).toBe(rows);
});

it('stores shift closures as UTC and normalizes them exactly once outside UTC', () => {
  for (const relativePath of [
    'src/app/actions-client/shifts.ts',
    'src/app/actions-client/handover.ts',
  ]) {
    const source = readFileSync(join(process.cwd(), relativePath), 'utf8');
    expect(source).toContain('SET end_time = CURRENT_TIMESTAMP, ending_cash = ?, notes = ?, status = ?');
  }

  const [once] = normalizeDatabaseTimestamps([{
    created_at: '2026-08-22 10:15:30',
    end_time: '2026-08-22 10:15:30',
    date: '2026-08-22 10:15:30',
  }]);
  const [twice] = normalizeDatabaseTimestamps([once]);

  expect(once).toEqual({
    created_at: '2026-08-22T10:15:30Z',
    end_time: '2026-08-22T10:15:30Z',
    date: '2026-08-22 10:15:30',
  });
  expect(twice).toEqual(once);
  expect(new Date(twice.end_time).toISOString()).toBe('2026-08-22T10:15:30.000Z');

  const localHour = execFileSync(process.execPath, [
    '-e',
    `process.stdout.write(String(new Date(${JSON.stringify(twice.end_time)}).getHours()))`,
  ], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'America/New_York' },
  });
  expect(localHour).toBe('6');
});
