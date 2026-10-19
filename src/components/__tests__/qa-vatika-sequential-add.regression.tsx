import React from 'react';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

let mockDb: Database.Database;
let mockCanManageInventory = true;
let mockOwnershipLookupFailure: string | null = null;
let mockSkipOwnershipLookupOnce = false;
let mockInsertFailure: string | null = null;
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params as any[])),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params as any[])),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const info = mockDb.prepare(sql).run(...params as any[]);
    return { rowsAffected: info.changes, lastInsertId: Number(info.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: (tx: any) => Promise<any>) => {
    mockDb.exec('BEGIN IMMEDIATE');
    const tx = { prepare: (sql: string) => ({
      all: async (...params: unknown[]) => {
        const ownershipLookup = sql.includes('SELECT id AS drug_id, LOWER(TRIM(barcode)) AS barcode_key');
        if (ownershipLookup && mockSkipOwnershipLookupOnce) {
          mockSkipOwnershipLookupOnce = false;
          return [];
        }
        if (ownershipLookup && mockOwnershipLookupFailure) {
          const message = mockOwnershipLookupFailure;
          mockOwnershipLookupFailure = null;
          throw new Error(message);
        }
        return mockDb.prepare(sql).all(...params as any[]);
      },
      get: async (...params: unknown[]) => mockDb.prepare(sql).get(...params as any[]),
      run: async (...params: unknown[]) => {
        if (mockInsertFailure && /^\s*INSERT INTO master_drugs\b/i.test(sql)) {
          const message = mockInsertFailure;
          mockInsertFailure = null;
          throw new Error(message);
        }
        const info = mockDb.prepare(sql).run(...params as any[]);
        return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
      },
    }) };
    try { const result = await callback(tx); mockDb.exec('COMMIT'); return result; }
    catch (error) { mockDb.exec('ROLLBACK'); throw error; }
  }),
  generateId: jest.fn(() => 'synthetic-id'),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'synthetic-admin', role: 'owner', pharmacy_id: 'local_default' })),
  hasUserPermissionSync: jest.fn((_user: unknown, permission: string) => permission !== 'can_manage_inventory' || mockCanManageInventory),
}));
jest.mock('@/lib/env', () => ({ isTauri: false }));
jest.mock('@/lib/cache/secure_cache', () => ({ secureCache: {
  addDrug: jest.fn(), load: jest.fn(async () => {}), reload: jest.fn(async () => {}),
  getAllDrugs: jest.fn(() => []), updateDrug: jest.fn(),
} }));
jest.mock('@/lib/inventory/refresh', () => ({ notifyDrugCatalogChanged: jest.fn(), notifyInventoryChanged: jest.fn(), notifyDrugIdentityChanged: jest.fn() }));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock('@/app/actions-client/master-drugs', () => {
  const real = jest.requireActual('@/app/actions-client/master-drugs');
  return { ...real, getUnitsAction: jest.fn(async () => ({ success: true, data: [{ name_ar: 'عبوة' }] })) };
});

import QuickAddDrugModal from '@/components/master-drugs/QuickAddDrugModal';
import { addMasterDrugAction } from '@/app/actions-client/master-drugs';
import { findDrugBarcodeConflict } from '@/app/actions-client/drug-replacement';
import { toast } from 'react-hot-toast';

const code180 = '6224007939161';
const code45 = '6224007939147';

beforeEach(() => {
  mockCanManageInventory = true;
  mockOwnershipLookupFailure = null;
  mockSkipOwnershipLookupOnce = false;
  mockInsertFailure = null;
  mockDb = new Database(':memory:');
  const schema = readFileSync('src-tauri/migrations/001_initial.sql', 'utf8');
  for (const table of ['master_drugs', 'inventory']) {
    const ddl = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))?.[0];
    if (!ddl) throw new Error(`missing schema for ${table}`);
    mockDb.exec(ddl);
  }
  mockDb.exec('CREATE TABLE activity_log(user_id TEXT,action TEXT,details TEXT)');
  jest.clearAllMocks();
});
afterEach(() => { cleanup(); mockDb.close(); });

function openAndFill(name: string, barcode: string, price: string) {
  const onSuccess = jest.fn();
  const view = render(<QuickAddDrugModal onClose={jest.fn()} onSuccess={onSuccess} />);
  fireEvent.change(screen.getByPlaceholderText('أدخل الاسم بالعربية'), { target: { value: name } });
  fireEvent.change(screen.getByPlaceholderText('Trade Name (EN)'), { target: { value: name } });
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: price } });
  fireEvent.change(screen.getByPlaceholderText('مثال: 3 (مطلوب)'), { target: { value: '1' } });
  fireEvent.change(screen.getByPlaceholderText('رقم الباركود (اختياري)'), { target: { value: barcode } });
  fireEvent.click(screen.getByRole('button', { name: 'حفظ الصنف' }));
  return { onSuccess, view };
}

it('two separate custom adds with different typed barcodes succeed and create distinct masters', async () => {
  const first = openAndFill('Vatika hair oil 180 ml', code180, '50');
  await waitFor(() => expect(first.onSuccess).toHaveBeenCalledWith(expect.any(Number), 'Vatika hair oil 180 ml', '', 50, 1, code180));
  first.view.unmount();
  const second = openAndFill('Vatica hair oil 45 ml', code45, '15');
  await waitFor(() => expect(second.onSuccess).toHaveBeenCalledWith(expect.any(Number), 'Vatica hair oil 45 ml', '', 15, 1, code45));
  expect(mockDb.prepare('SELECT trade_name_en,barcode FROM master_drugs ORDER BY id').all()).toEqual([
    { trade_name_en: 'Vatika hair oil 180 ml', barcode: code180 },
    { trade_name_en: 'Vatica hair oil 45 ml', barcode: code45 },
  ]);
  expect(screen.queryByRole('dialog', { name: /استبدال الصنف القديم/ })).not.toBeInTheDocument();
});

it('different typed master barcodes still conflict if 45 barcode is owned by an active 180 lot', async () => {
  const first = openAndFill('Vatika hair oil 180 ml', code180, '50');
  await waitFor(() => expect(first.onSuccess).toHaveBeenCalled());
  first.view.unmount();
  const id = mockDb.prepare('SELECT id FROM master_drugs LIMIT 1').get() as { id: number };
  mockDb.prepare('INSERT INTO inventory(id,drug_id,pharmacy_id,quantity,barcode,cost_price) VALUES(?,?,?,?,?,?)')
    .run('synthetic-positive-lot', id.id, 'local_default', 1, code45, 10);
  const second = openAndFill('Vatica hair oil 45 ml', code45, '15');
  const warning = await screen.findByRole('alert');
  expect(warning).toHaveTextContent(code45);
  expect(warning).toHaveTextContent(code180);
  expect(warning).toHaveTextContent('دفعة مخزون');
  expect(screen.queryByRole('dialog', { name: /استبدال الصنف القديم/ })).not.toBeInTheDocument();
  expect(second.onSuccess).not.toHaveBeenCalled();
  expect(await findDrugBarcodeConflict(code45)).toMatchObject({ id: id.id, barcode: code180 });
  expect(mockDb.prepare('SELECT COUNT(*) AS count FROM master_drugs').get()).toEqual({ count: 1 });
  expect(mockDb.prepare('SELECT drug_id,barcode,quantity FROM inventory').get()).toMatchObject({ drug_id: id.id, barcode: code45, quantity: 1 });
});

it('screenshot-shaped old master 9147 and active lot 9161 reveal why second 9147 triggers warning', async () => {
  const first = openAndFill('Vatika hair oil 180 ml', code45, '50');
  await waitFor(() => expect(first.onSuccess).toHaveBeenCalled());
  first.view.unmount();
  const id = mockDb.prepare('SELECT id FROM master_drugs LIMIT 1').get() as { id: number };
  mockDb.prepare('INSERT INTO inventory(id,drug_id,pharmacy_id,quantity,barcode,cost_price) VALUES(?,?,?,?,?,?)')
    .run('synthetic-old-lot', id.id, 'local_default', 1, code180, 10);
  const second = openAndFill('Vatica hair oil 45 ml', code45, '15');
  const warning = await screen.findByRole('alert');
  expect(warning).toHaveTextContent(code180);
  expect(warning).toHaveTextContent(code45);
  expect(warning).toHaveTextContent('بطاقة الصنف');
  expect(screen.queryByRole('dialog', { name: /استبدال الصنف القديم/ })).not.toBeInTheDocument();
  expect(second.onSuccess).not.toHaveBeenCalled();
  expect(mockDb.prepare('SELECT COUNT(*) AS count FROM master_drugs').get()).toEqual({ count: 1 });
});

it('permission denial must not be presented as item replacement merely because a barcode owner can be found', async () => {
  const first = await addMasterDrugAction({ trade_name: 'Vatika hair oil 180 ml', trade_name_en: 'Vatika hair oil 180 ml', barcode: code45, official_price: 50 });
  expect(first.success).toBe(true);
  // The add is forbidden, while barcode-owner lookup is allowed to a purchase viewer.
  mockCanManageInventory = false;
  const second = openAndFill('Vatica hair oil 45 ml', code45, '15');
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('غير مصرح'));
  expect(second.onSuccess).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog', { name: /استبدال الصنف القديم/ })).not.toBeInTheDocument();
});

it('unrelated barcode service outage keeps the existing matching owner and never offers destructive replacement', async () => {
  const first = openAndFill('Vatika hair oil 180 ml', code180, '50');
  await waitFor(() => expect(first.onSuccess).toHaveBeenCalled());
  first.view.unmount();
  const existing = mockDb.prepare('SELECT id FROM master_drugs WHERE barcode = ?').get(code180) as { id: number };
  expect(await findDrugBarcodeConflict(code180)).toMatchObject({ id: existing.id });

  const outage = 'Barcode lookup service temporarily unavailable';
  mockOwnershipLookupFailure = outage;
  const second = openAndFill('Vatika hair oil 180 ml alternate spelling', code180, '50');
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith(outage));
  expect(mockOwnershipLookupFailure).toBeNull();
  expect(screen.queryByRole('dialog', { name: /استبدال الصنف القديم/ })).not.toBeInTheDocument();
  expect(second.onSuccess).not.toHaveBeenCalled();
  expect(mockDb.prepare('SELECT id,barcode FROM master_drugs').all()).toEqual([{ id: existing.id, barcode: code180 }]);
});

it.each([
  'Invalid barcode format',
  'Permission denied while indexing barcode',
  'خدمة الباركود غير متاحة',
])('non-collision action failure "%s" cannot propose replacing a matching drug', async (message) => {
  const first = await addMasterDrugAction({ trade_name: 'Vatika hair oil 180 ml', trade_name_en: 'Vatika hair oil 180 ml', barcode: code180, official_price: 50 });
  expect(first.success).toBe(true);
  mockOwnershipLookupFailure = message;

  const second = openAndFill('Vatika hair oil 180 ml alternate spelling', code180, '50');
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message));
  expect(mockOwnershipLookupFailure).toBeNull();
  expect(second.onSuccess).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog', { name: /استبدال الصنف القديم/ })).not.toBeInTheDocument();
  expect(mockDb.prepare('SELECT COUNT(*) AS count FROM master_drugs').get()).toEqual({ count: 1 });
});

it.each([
  ['UNIQUE constraint failed: master_drugs.barcode', true],
  ['UNIQUE constraint failed: master_drugs.trade_name', false],
] as const)('SQLite error "%s" opens replacement only for the barcode unique constraint', async (message, isBarcodeCollision) => {
  const first = await addMasterDrugAction({ trade_name: 'Vatika hair oil 180 ml', trade_name_en: 'Vatika hair oil 180 ml', barcode: code180, official_price: 50 });
  expect(first.success).toBe(true);
  // Simulate a stale, empty ownership preflight followed by an INSERT uniqueness error.
  mockSkipOwnershipLookupOnce = true;
  mockInsertFailure = `error returned from database: (code: 2067) ${message}`;

  const second = openAndFill('Vatika hair oil 180 ml alternate spelling', code180, '50');
  if (isBarcodeCollision) {
    expect(await screen.findByRole('dialog', { name: /استبدال الصنف القديم/ })).toBeInTheDocument();
  } else {
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(`error returned from database: (code: 2067) ${message}`));
    expect(screen.queryByRole('dialog', { name: /استبدال الصنف القديم/ })).not.toBeInTheDocument();
  }
  expect(mockSkipOwnershipLookupOnce).toBe(false);
  expect(mockInsertFailure).toBeNull();
  expect(second.onSuccess).not.toHaveBeenCalled();
  expect(mockDb.prepare('SELECT COUNT(*) AS count FROM master_drugs').get()).toEqual({ count: 1 });
});

it('only a matching pack-size duplicate may enter the explicitly reviewed replacement workflow', async () => {
  const first = openAndFill('Vatika hair oil 180 ml', code180, '50');
  await waitFor(() => expect(first.onSuccess).toHaveBeenCalled());
  first.view.unmount();
  const second = openAndFill('Vatika hair oil 180 ml alternate spelling', code180, '50');
  expect(await screen.findByRole('dialog', { name: /استبدال الصنف القديم/ })).toBeInTheDocument();
  expect(second.onSuccess).not.toHaveBeenCalled();
  expect(mockDb.prepare('SELECT COUNT(*) AS count FROM master_drugs').get()).toEqual({ count: 1 });
});
