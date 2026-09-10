import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
let mockDb: Database.Database;
jest.mock('@/lib/db/tauri', () => ({
  dbGet: jest.fn(async (sql: string, params: any[]) => mockDb.prepare(sql).get(...params)),
  dbSelect: jest.fn(async (sql: string, params: any[]) => mockDb.prepare(sql).all(...params)),
}));
jest.mock('@/lib/auth/local', () => ({ getLocalSession: jest.fn(async () => ({ id: 'admin', role: 'admin' })), hasUserPermissionSync: jest.fn(() => true) }));
jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@/lib/cache/secure_cache', () => ({ secureCache: { reload: jest.fn(async () => {}) } }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn() }));
import { findDrugBarcodeConflict, getReplacementDrug, replaceDrugAction } from '../drug-replacement';
import { invoke } from '@tauri-apps/api/core';
import { getLocalSession } from '@/lib/auth/local';

beforeEach(() => {
  jest.clearAllMocks();
  mockDb = new Database(':memory:');
  mockDb.exec(`CREATE TABLE master_drugs(id INTEGER PRIMARY KEY,trade_name TEXT,trade_name_en TEXT,barcode TEXT,large_to_medium INTEGER,official_price REAL);
    CREATE TABLE inventory(drug_id INTEGER,barcode TEXT,quantity REAL);
    INSERT INTO master_drugs VALUES(10,'Old',NULL,NULL,2,20),(20,'Correct',NULL,'123',2,40);
    INSERT INTO inventory VALUES(10,'123',1.5),(10,'456',0.5);`);
});
afterEach(() => mockDb.close());

it('detects a barcode remaining on old batches and returns complete comparison evidence', async () => {
  expect(await findDrugBarcodeConflict('123',20)).toMatchObject({ id: 10, barcode: null });
  expect(await getReplacementDrug(10)).toMatchObject({ id: 10, stock_quantity: 2, inventory_barcodes: '123,456' });
  expect(await getReplacementDrug(20)).toMatchObject({ id: 20, stock_quantity: 0, barcode: '123' });
});

it('ignores only exhausted batch aliases without deleting historical evidence', async () => {
  mockDb.exec("UPDATE inventory SET quantity=0 WHERE barcode='123'");
  expect(await findDrugBarcodeConflict('123',20)).toBeFalsy();
  expect(await getReplacementDrug(10)).toMatchObject({ inventory_barcodes:'123,456', stock_quantity:0.5 });
  mockDb.exec("UPDATE master_drugs SET barcode='123' WHERE id=10");
  expect(await findDrugBarcodeConflict('123',20)).toMatchObject({id:10});
});

it.each([0.001,-1,null])('still blocks a batch with a nonzero or unknown balance (%s)', async quantity => {
  mockDb.prepare("UPDATE inventory SET quantity=? WHERE barcode='123'").run(quantity);
  expect(await findDrugBarcodeConflict('123',20)).toMatchObject({id:10});
});

it.each([0,0.001,-1,null])('uses the same zero-balance rule in the native purchase SQL (%s)', async quantity => {
  const source = readFileSync('src-tauri/src/commands/critical.rs','utf8');
  const sql = source.match(/SELECT id FROM master_drugs\s+WHERE id != \?[\s\S]*?UNION ALL[\s\S]*?LIMIT 1/)?.[0];
  expect(sql).toBeDefined();
  mockDb.prepare("UPDATE inventory SET quantity=? WHERE barcode='123'").run(quantity);
  const nativeConflict = mockDb.prepare(sql!).get(20,'123',20,'123');
  expect(Boolean(nativeConflict)).toBe(quantity !== 0);
  mockDb.exec("UPDATE master_drugs SET barcode='123' WHERE id=10");
  expect(mockDb.prepare(sql!).get(20,'123',20,'123')).toEqual({id:10});
});

it('sends corrections in the same native replacement command, not separate catalog updates', async () => {
  (invoke as jest.Mock).mockResolvedValue({ id:20, backup_path:'backup.db' });
  expect(await replaceDrugAction(10,20,null,'password',{ official_price:45, notes:'' })).toMatchObject({ success:true, id:20 });
  expect(invoke).toHaveBeenCalledWith('replace_master_drug', { userId:'admin',password:'password',payload:{ source_id:10,target_id:20,new_drug:null,edits:{ official_price:45,notes:'' },confirmed_same_product:true } });
});

it('does not send a destructive command for an unauthorized user', async () => {
  (getLocalSession as jest.Mock).mockResolvedValueOnce({ id:'cashier',role:'cashier' });
  expect(await replaceDrugAction(10,20,null,'password',{})).toMatchObject({ success:false });
  expect(invoke).not.toHaveBeenCalled();
});
