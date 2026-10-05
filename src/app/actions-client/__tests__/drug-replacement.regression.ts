import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
let mockDb: Database.Database;
let mockSession: any = { id: 'admin', role: 'admin', pharmacy_id: 'ph-a' };
jest.mock('@/lib/db/tauri', () => ({
  dbGet: jest.fn(async (sql: string, params: any[]) => mockDb.prepare(sql).get(...params)),
  dbSelect: jest.fn(async (sql: string, params: any[]) => mockDb.prepare(sql).all(...params)),
}));
jest.mock('@/lib/auth/local', () => ({ getLocalSession: jest.fn(async () => mockSession), hasUserPermissionSync: jest.fn(() => true) }));
jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@/lib/cache/secure_cache', () => ({ secureCache: { reload: jest.fn(async () => {}) } }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn() }));
import { correctDrugBarcodeConflictAction, findDrugBarcodeConflict, findDrugBarcodeOwners, getDuplicateDrugBarcodeGroupsAction, getReplacementDrug, reconcileDrugBarcodeOwnersAction, replaceDrugAction } from '../drug-replacement';
import { invoke } from '@tauri-apps/api/core';
import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  mockSession = { id: 'admin', role: 'admin', pharmacy_id: 'ph-a' };
  mockDb = new Database(':memory:');
  mockDb.exec(`CREATE TABLE master_drugs(id INTEGER PRIMARY KEY,trade_name TEXT,trade_name_en TEXT,barcode TEXT,large_to_medium INTEGER,official_price REAL);
    CREATE TABLE inventory(drug_id INTEGER,barcode TEXT,quantity REAL,pharmacy_id TEXT DEFAULT 'ph-a');
    INSERT INTO master_drugs VALUES(10,'Old',NULL,NULL,2,20),(20,'Correct',NULL,'123',2,40);
    INSERT INTO inventory(drug_id,barcode,quantity) VALUES(10,'123',1.5),(10,'456',0.5);`);
});
afterEach(() => mockDb.close());

it('detects a barcode remaining on old batches and returns complete comparison evidence', async () => {
  expect(await findDrugBarcodeConflict('123',20)).toMatchObject({ id: 10, barcode: null });
  expect(await getReplacementDrug(10)).toMatchObject({ id: 10, stock_quantity: 2, inventory_barcodes: '123,456', active_inventory_barcodes: '123,456' });
  expect(await getReplacementDrug(20)).toMatchObject({ id: 20, stock_quantity: 0, barcode: '123' });
});

it('ignores only exhausted batch aliases without deleting historical evidence', async () => {
  mockDb.exec("UPDATE inventory SET quantity=0 WHERE barcode='123'");
  expect(await findDrugBarcodeConflict('123',20)).toBeFalsy();
  expect(await getReplacementDrug(10)).toMatchObject({ inventory_barcodes:'123,456', active_inventory_barcodes:'456', stock_quantity:0.5 });
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

it('returns every active owner of a conflicting barcode and ignores exhausted inventory-only aliases', async () => {
  mockDb.exec(`
    INSERT INTO master_drugs VALUES(30,'Third',NULL,'123',2,30);
    INSERT INTO master_drugs VALUES(40,'Exhausted alias',NULL,NULL,2,30);
    INSERT INTO inventory(drug_id,barcode,quantity) VALUES(40,'123',0);
  `);
  expect((await findDrugBarcodeOwners('123')).map((drug: any) => drug.id)).toEqual([10,20,30]);
});

it('keeps global barcode owners while hiding foreign-pharmacy stock and lot barcode evidence', async () => {
  mockDb.exec(`
    INSERT INTO master_drugs VALUES(30,'Foreign inventory owner',NULL,NULL,2,30);
    INSERT INTO inventory(drug_id,barcode,quantity,pharmacy_id) VALUES
      (10,'FOREIGN-ONLY',9,'ph-b'),
      (30,'123',7,'ph-b');
  `);

  const owners = await findDrugBarcodeOwners('123');
  expect(owners.map((drug: any) => drug.id)).toEqual([10,20,30]);
  expect(owners.find((drug: any) => drug.id === 10)).toMatchObject({
    stock_quantity: 2,
    inventory_barcodes: '123,456',
  });
  expect(owners.find((drug: any) => drug.id === 30)).toMatchObject({
    stock_quantity: 0,
    inventory_barcodes: null,
  });

  expect(await getReplacementDrug(10)).toMatchObject({
    stock_quantity: 2,
    inventory_barcodes: '123,456',
    active_inventory_barcodes: '123,456',
  });
});

it('lists every duplicate-barcode group with the same active-owner rule used by purchase validation', async () => {
  mockDb.exec(`
    INSERT INTO master_drugs VALUES(30,'Third',NULL,'123',2,30);
    INSERT INTO master_drugs VALUES(40,'Other A',NULL,'999',2,30);
    INSERT INTO master_drugs VALUES(50,'Other B',NULL,'999',2,30);
    INSERT INTO master_drugs VALUES(60,'Historical only',NULL,NULL,2,30);
    INSERT INTO inventory(drug_id,barcode,quantity) VALUES(60,'123',0);
  `);
  const groups = await getDuplicateDrugBarcodeGroupsAction();
  expect(groups).toEqual(expect.arrayContaining([
    expect.objectContaining({ barcode: '123', owner_count: 3, owner_ids: [10,20,30] }),
    expect.objectContaining({ barcode: '999', owner_count: 2, owner_ids: [40,50] }),
  ]));
  expect(groups.find((group: any) => group.barcode === '123')?.owner_ids).not.toContain(60);
});

it('sends corrections in the same native replacement command, not separate catalog updates', async () => {
  (invoke as jest.Mock).mockResolvedValue({ id:20, backup_path:'backup.db' });
  expect(await replaceDrugAction(10,20,null,'password',{ official_price:45, notes:'' })).toMatchObject({ success:true, id:20 });
  expect(invoke).toHaveBeenCalledWith('replace_master_drug', { userId:'admin',password:'password',payload:{ source_id:10,target_id:20,new_drug:null,edits:{ official_price:45,notes:'' },confirmed_same_product:true } });
});

it('sends all explicitly confirmed duplicate owners in one native group reconciliation', async () => {
  (invoke as jest.Mock).mockResolvedValue({ id:20, backup_path:'group-backup.db' });
  expect(await reconcileDrugBarcodeOwnersAction([10,30],20,'password',{ trade_name:'Canonical' })).toMatchObject({ success:true, id:20 });
  expect(invoke).toHaveBeenCalledWith('reconcile_master_drug_group', {
    userId:'admin',
    password:'password',
    payload:{ source_ids:[10,30],target_id:20,edits:{ trade_name:'Canonical' },confirmed_same_product:true },
  });
  const identityChange = JSON.parse(localStorage.getItem('pharma:drug-identity-updated') || '{}');
  expect(identityChange).toMatchObject({ sourceIds:[10,30], targetId:20 });
});

it('sends an explicit different-product barcode correction through the protected native command', async () => {
  (invoke as jest.Mock).mockResolvedValue({ id:10, backup_path:'barcode-backup.db' });
  expect(await correctDrugBarcodeConflictAction(10,'123','456','password')).toMatchObject({ success:true, id:10 });
  expect(invoke).toHaveBeenCalledWith('correct_drug_barcode_conflict', {
    userId:'admin',
    password:'password',
    payload:{ drug_id:10, conflicting_barcode:'123', replacement_barcode:'456' },
  });
});

it('does not send a destructive command for an unauthorized user', async () => {
  (getLocalSession as jest.Mock).mockResolvedValueOnce({ id:'cashier',role:'cashier' });
  expect(await replaceDrugAction(10,20,null,'password',{})).toMatchObject({ success:false });
  expect(invoke).not.toHaveBeenCalled();
});

it('does not let an admin bypass an explicit inventory-management denial', async () => {
  (getLocalSession as jest.Mock).mockResolvedValueOnce({
    id: 'admin',
    role: 'admin',
    permissions: { can_view_purchases: true, can_manage_inventory: false },
  });
  (hasUserPermissionSync as jest.Mock).mockImplementation((_user: any, key: string) => key !== 'can_manage_inventory');
  (invoke as jest.Mock).mockResolvedValue({ id: 20, backup_path: 'backup.db' });

  expect(await replaceDrugAction(10,20,null,'password',{})).toMatchObject({ success:false });
  expect(invoke).not.toHaveBeenCalled();
});
