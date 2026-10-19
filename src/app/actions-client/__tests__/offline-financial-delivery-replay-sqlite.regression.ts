/** @jest-environment node */

// Disposable simulation of the native delivery cash protocol, NOT a substitute
// for Rust command/integration tests. The source 043/045 migrations and exact
// native 045 receipt-confirmation SELECT run against SQLite :memory: only.
// No renderer SQL is allowed: all SQL below is test-owned native-fixture code.
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mockInvoke = jest.fn();
const forbiddenRendererSql = jest.fn(() => { throw new Error('Generic renderer SQL forbidden'); });
const forbiddenRendererSession = jest.fn(() => { throw new Error('Renderer session is not native identity'); });

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: () => forbiddenRendererSession(),
  hasUserPermissionSync: () => forbiddenRendererSession(),
}));
jest.mock('@/app/actions-client/finance', () => ({ requireOpenShiftId: () => forbiddenRendererSession() }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: () => forbiddenRendererSql(),
  dbGet: () => forbiddenRendererSql(),
  dbExecute: () => forbiddenRendererSql(),
  dbTransaction: () => forbiddenRendererSql(),
  generateId: () => forbiddenRendererSql(),
}));

let closeDeliveryInvoiceAction: typeof import('../delivery').closeDeliveryInvoiceAction;
let getPendingDeliveriesAction: typeof import('../delivery').getPendingDeliveriesAction;

const NONCE = 'a1234567-aaaa-4aaa-8aaa-123456789abc';
const OTHER_NONCE = 'b1234567-bbbb-4bbb-8bbb-123456789abc';
const MIGRATIONS = join(process.cwd(), 'src-tauri', 'migrations');
const NATIVE_SOURCE = join(process.cwd(), 'src-tauri', 'src', 'commands', 'delivery_collection_native.rs');
type Payload = { saleId: string; deliveryFee: number; requestId: string };
type Receipt = { id: string; saleId: string; deliveryFee: number; collectedAmount: number };

function loadNativeConfirmationQuery(): string {
  const source = readFileSync(NATIVE_SOURCE, 'utf8');
  const match = source.match(/let row = sqlx::query\(\s*"(SELECT r\.id,r\.total_cents[\s\S]*?LIMIT 1)"\s*,?\s*\)/);
  if (!match) throw new Error('Native confirmation SQL moved: update the fixture rather than guessing receipt proof');
  return match[1];
}

function fixture(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  // Same minimal schema and 043/045 migration ordering as Rust's delivery fixture.
  sqlite.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,pharmacy_id TEXT,is_active INTEGER,permissions TEXT);
    INSERT INTO users VALUES('owner-a','owner','A',1,'{}'),('owner-b','owner','B',1,'{}');
    CREATE TABLE shifts(id TEXT PRIMARY KEY,user_id TEXT,pharmacy_id TEXT,status TEXT);
    INSERT INTO shifts VALUES('open-a','owner-a','A','open'),('open-b','owner-b','B','open');
    CREATE TABLE sales_invoices(id TEXT PRIMARY KEY,user_id TEXT,pharmacy_id TEXT,status TEXT,
      payment_method TEXT,total_amount REAL);
    INSERT INTO sales_invoices VALUES('offline-sale-a','owner-a','A','completed','delivery',20.0);
    CREATE TABLE sales_items(id INTEGER PRIMARY KEY,invoice_id TEXT,inventory_id TEXT,drug_id INTEGER,
      is_negative INTEGER,cost_price REAL,quantity_sold REAL,unit_price REAL,
      unit TEXT,large_to_medium REAL,medium_to_small REAL);
    INSERT INTO sales_items VALUES(1,'offline-sale-a',NULL,1,1,0,1,20,'large',1,1);
    CREATE TABLE returns(id TEXT PRIMARY KEY,invoice_id TEXT,user_id TEXT,pharmacy_id TEXT,
      status TEXT,total_refund REAL,refund_method TEXT);
    CREATE TABLE return_items(id INTEGER PRIMARY KEY,return_id TEXT,inventory_id TEXT,drug_id INTEGER,
      sale_item_id INTEGER,quantity_returned REAL,unit TEXT,total_price REAL);
    CREATE TABLE inventory(id TEXT PRIMARY KEY,pharmacy_id TEXT,drug_id INTEGER);
    CREATE TABLE accounts(id INTEGER PRIMARY KEY,code TEXT UNIQUE,parent_id INTEGER,
      type TEXT,is_group INTEGER);
    INSERT INTO accounts VALUES
      (6,'1.1.1',NULL,'asset',0),(8,'1.1.2',NULL,'asset',0),
      (9,'3.1',NULL,'revenue',0),(10,'1.1.3',NULL,'asset',0),
      (11,'4.1',NULL,'expense',0),(12,'3.2',NULL,'revenue',0);
    CREATE TABLE trial_balance_settings(category TEXT UNIQUE,account_id INTEGER,target_type TEXT);
    INSERT INTO trial_balance_settings VALUES('cash_drawer',6,'account'),
      ('accounts_receivable',8,'account'),('other_cash_income',12,'account');
    CREATE TABLE daily_journals(id TEXT PRIMARY KEY,date TEXT,description TEXT,
      created_by TEXT,total_amount REAL,pharmacy_id TEXT);
    CREATE TABLE journal_entries(id INTEGER PRIMARY KEY AUTOINCREMENT,journal_id TEXT,
      account_id INTEGER,type TEXT,amount REAL);
    CREATE TABLE cash_movements(id TEXT PRIMARY KEY,user_id TEXT,shift_id TEXT,type TEXT,
      category TEXT,amount REAL,notes TEXT,date TEXT,pharmacy_id TEXT,source_type TEXT);
    CREATE TABLE activity_log(user_id TEXT,action TEXT,details TEXT,pharmacy_id TEXT);
  `);
  sqlite.exec(readFileSync(join(MIGRATIONS, '043_native_sales_cogs_provenance.sql'), 'utf8'));
  sqlite.exec(`
    INSERT INTO daily_journals VALUES('original','2026-10-17','Original 043 sale','owner-a',20.0,'A');
    INSERT INTO journal_entries(journal_id,account_id,type,amount)
      VALUES('original',8,'debit',20.0),('original',9,'credit',20.0);
    INSERT INTO native_sale_cogs_provenance
      (sale_id,request_id,pharmacy_id,actor_id,journal_id,payment_method,
       sale_micros,cogs_micros,line_count,line_snapshot)
      VALUES('offline-sale-a','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','A','owner-a',
        'original','delivery',20000000,0,1,'[{}]');
  `);
  sqlite.exec(readFileSync(join(MIGRATIONS, '045_native_delivery_collection.sql'), 'utf8'));
  return sqlite;
}

function scalar(sqlite: Database.Database, sql: string): number {
  return (sqlite.prepare(sql).get() as { n: number }).n;
}

function totals(sqlite: Database.Database) {
  return {
    receipts: scalar(sqlite, 'SELECT count(*) n FROM native_delivery_collection_receipts'),
    movements: scalar(sqlite, "SELECT count(*) n FROM cash_movements WHERE source_type='delivery_collection'"),
    journals: scalar(sqlite, "SELECT count(*) n FROM daily_journals WHERE id LIKE 'delivery-journal-%'"),
    entries: scalar(sqlite, "SELECT count(*) n FROM journal_entries WHERE journal_id LIKE 'delivery-journal-%'"),
    activity: scalar(sqlite, "SELECT count(*) n FROM activity_log WHERE action='DELIVERY_COLLECTED_NATIVE'"),
    originalEntries: scalar(sqlite, "SELECT count(*) n FROM journal_entries WHERE journal_id='original'"),
  };
}

// The stub is deliberately less authoritative than Rust: Rust enforces actor
// permission, whole-cent validation, serialized writer lock, immutable source,
// exact sale/return provenance, and canonical nonce BEFORE this transaction.
// Here actual 043/045 SQLite triggers independently reject forged receipts.
function postSimulatedNative(sqlite: Database.Database, actor: string, payload: Payload): Receipt {
  return sqlite.transaction(() => {
    const user = sqlite.prepare('SELECT pharmacy_id FROM users WHERE id=? AND is_active=1')
      .get(actor) as { pharmacy_id: string } | undefined;
    if (!user || user.pharmacy_id === 'local_default') throw new Error('Native actor not verified');
    if (sqlite.prepare('SELECT 1 FROM native_delivery_collection_receipts WHERE request_id=? OR sale_id=?')
      .get(payload.requestId, payload.saleId)) throw new Error('Delivery already collected or nonce reused');
    const source = sqlite.prepare(`SELECT s.total_amount, s.pharmacy_id FROM sales_invoices s
      JOIN native_sale_cogs_provenance p ON p.sale_id=s.id AND p.pharmacy_id=s.pharmacy_id
      WHERE s.id=? AND s.pharmacy_id=? AND s.payment_method='delivery' AND s.status='completed'`)
      .get(payload.saleId, user.pharmacy_id) as { total_amount: number; pharmacy_id: string } | undefined;
    if (!source) throw new Error('Verified native delivery source required');
    const feeCents = Math.round(payload.deliveryFee * 100);
    const saleCents = Math.round(source.total_amount * 100);
    if (!Number.isFinite(payload.deliveryFee) || feeCents < 0 ||
      Math.abs(payload.deliveryFee * 100 - feeCents) > 0.0000001) throw new Error('Noncent money');
    const totalCents = saleCents + feeCents;
    if (totalCents <= 0) throw new Error('Zero collection');
    const shift = sqlite.prepare('SELECT id FROM shifts WHERE pharmacy_id=? AND status=\'open\'')
      .all(user.pharmacy_id) as { id: string }[];
    if (shift.length !== 1) throw new Error('Ambiguous open drawer');
    const journalId = `delivery-journal-${payload.requestId}`;
    const movementId = `delivery-cash-${payload.requestId}`;
    const receiptId = `delivery-${payload.requestId}`;
    const total = totalCents / 100;
    sqlite.prepare('INSERT INTO daily_journals VALUES(?,\'2026-10-17\',?,?,?,?)')
      .run(journalId, `Synthetic delivery collection ${payload.saleId}`, actor, total, user.pharmacy_id);
    const entry = sqlite.prepare('INSERT INTO journal_entries(journal_id,account_id,type,amount) VALUES(?,?,?,?)');
    entry.run(journalId, 6, 'debit', total);
    if (saleCents) entry.run(journalId, 8, 'credit', saleCents / 100);
    if (feeCents) entry.run(journalId, 12, 'credit', feeCents / 100);
    sqlite.prepare(`INSERT INTO cash_movements
      VALUES(?,?,?,'receipt','delivery',?,'synthetic','2026-10-17',?,'delivery_collection')`)
      .run(movementId, actor, shift[0].id, total, user.pharmacy_id);
    // Applies the production 045 independent source+journal+cash guard AND its
    // atomic status transition. A denial rolls back the entire test transaction.
    sqlite.prepare(`INSERT INTO native_delivery_collection_receipts
      (id,request_id,sale_id,pharmacy_id,actor_id,shift_id,journal_id,
       movement_id,sale_cents,fee_cents,total_cents)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(receiptId, payload.requestId, payload.saleId, user.pharmacy_id,
        actor, shift[0].id, journalId, movementId, saleCents, feeCents, totalCents);
    sqlite.prepare('INSERT INTO activity_log VALUES(?,\'DELIVERY_COLLECTED_NATIVE\',?,?)')
      .run(actor, payload.requestId, user.pharmacy_id);
    return { id: receiptId, saleId: payload.saleId, deliveryFee: feeCents / 100, collectedAmount: total };
  })();
}

function confirmUsingNativeSql(sqlite: Database.Database, actor: string, payload: Payload): Receipt | null {
  const user = sqlite.prepare('SELECT pharmacy_id FROM users WHERE id=? AND is_active=1')
    .get(actor) as { pharmacy_id: string } | undefined;
  if (!user || user.pharmacy_id === 'local_default') throw new Error('Not authenticated in native receipt read');
  const row = (sqlite.prepare(loadNativeConfirmationQuery())
    .get(payload.requestId, payload.saleId, user.pharmacy_id, actor,
      Math.round(payload.deliveryFee * 100), `delivery-${payload.requestId}`,
      `delivery-journal-${payload.requestId}`, `delivery-cash-${payload.requestId}`)) as
      { id: string; total_cents: number } | undefined;
  return row ? { id: row.id, saleId: payload.saleId, deliveryFee: payload.deliveryFee,
    collectedAmount: row.total_cents / 100 } : null;
}

describe('offline cash collection: disposable SQLite 043/045 receipts and ambiguous IPC ACK', () => {
  let sqlite: Database.Database;
  let actor: string;
  let writeCalls: number;
  let confirmCalls: number;
  let dropWriteAck: boolean;
  let offlineConfirm: boolean;
  let offlineQueue: boolean;
  let injectLateFailure: boolean;
  const savedCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const savedLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let savedIntents: Map<string, string>;
  let failStorageWrite: boolean;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.resetModules(); // Each synthetic test starts with a fresh renderer module.
    ({ closeDeliveryInvoiceAction, getPendingDeliveriesAction } = await import('../delivery'));
    sqlite = fixture();
    actor = 'owner-a';
    writeCalls = 0;
    confirmCalls = 0;
    dropWriteAck = false;
    offlineConfirm = false;
    offlineQueue = false;
    injectLateFailure = false;
    failStorageWrite = false;
    savedIntents = new Map();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: jest.fn((key: string) => savedIntents.get(key) ?? null),
        setItem: jest.fn((key: string, value: string) => {
          if (failStorageWrite) throw new Error('Pending request storage is denied');
          savedIntents.set(key, value);
        }),
        removeItem: jest.fn((key: string) => { savedIntents.delete(key); }),
      },
    });
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true, value: { randomUUID: jest.fn().mockReturnValue(NONCE) },
    });
    mockInvoke.mockImplementation(async (command: string, args: { payload: Payload }) => {
      if (command === 'collect_delivery_native') {
        writeCalls += 1;
        if (injectLateFailure) {
          sqlite.exec(`CREATE TEMP TRIGGER synthetic_activity_failure
            BEFORE INSERT ON activity_log BEGIN SELECT RAISE(ABORT,'Synthetic final audit unavailable'); END;`);
        }
        const posted = postSimulatedNative(sqlite, actor, args.payload);
        if (dropWriteAck) throw new Error('IPC reply lost AFTER synthetic SQLite COMMIT');
        return posted;
      }
      if (command === 'confirm_delivery_collection_native') {
        confirmCalls += 1;
        if (offlineConfirm) throw new Error('Receipt read transport offline');
        return confirmUsingNativeSql(sqlite, actor, args.payload);
      }
      if (command === 'list_pending_deliveries_native') {
        if (offlineQueue) throw new Error('Chromium network/offline read unavailable');
        return { rows: [], hasMore: false, nextCursor: null };
      }
      throw new Error(`Unexpected IPC command: ${command}`);
    });
  });

  afterEach(() => sqlite.close());
  afterAll(() => {
    if (savedCrypto) Object.defineProperty(globalThis, 'crypto', savedCrypto);
    else Reflect.deleteProperty(globalThis, 'crypto');
    if (savedLocalStorage) Object.defineProperty(globalThis, 'localStorage', savedLocalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('treats Chromium offline queue failure as only a READ failure, not a lost-commit acknowledgement', async () => {
    offlineQueue = true;
    expect(await getPendingDeliveriesAction()).toMatchObject({ success: false });
    expect(totals(sqlite)).toEqual({ receipts: 0, movements: 0, journals: 0,
      entries: 0, activity: 0, originalEntries: 2 });
    expect(writeCalls).toBe(0);
    expect(confirmCalls).toBe(0);
    expect(forbiddenRendererSql).not.toHaveBeenCalled();
    expect(forbiddenRendererSession).not.toHaveBeenCalled();
  });

  it('recovers a dropped IPC ACK using the exact native SELECT; commits only one balanced 045 tender', async () => {
    dropWriteAck = true;
    expect(await closeDeliveryInvoiceAction('offline-sale-a', 2.25)).toEqual({ success: true });
    expect(writeCalls).toBe(1);
    expect(confirmCalls).toBe(1);
    expect(totals(sqlite)).toEqual({ receipts: 1, movements: 1, journals: 1,
      entries: 3, activity: 1, originalEntries: 2 });
    expect(sqlite.prepare('SELECT status,total_amount FROM sales_invoices WHERE id=?')
      .get('offline-sale-a')).toEqual({ status: 'delivered', total_amount: 20 });
    const entries = sqlite.prepare('SELECT account_id,type,amount FROM journal_entries WHERE journal_id=? ORDER BY id')
      .all(`delivery-journal-${NONCE}`);
    expect(entries).toEqual([
      { account_id: 6, type: 'debit', amount: 22.25 },
      { account_id: 8, type: 'credit', amount: 20 },
      { account_id: 12, type: 'credit', amount: 2.25 },
    ]);
    expect(() => sqlite.prepare('UPDATE native_delivery_collection_receipts SET fee_cents=0').run()).toThrow();
    expect(() => sqlite.prepare("UPDATE sales_invoices SET total_amount=90 WHERE id='offline-sale-a'").run()).toThrow();
    expect(() => sqlite.prepare('DELETE FROM cash_movements WHERE id=?').run(`delivery-cash-${NONCE}`)).toThrow();
    expect(forbiddenRendererSql).not.toHaveBeenCalled();
    expect(forbiddenRendererSession).not.toHaveBeenCalled();
  });

  it('does NOT claim success while both the write ACK and receipt read are unavailable; retries one nonce', async () => {
    dropWriteAck = true;
    offlineConfirm = true;
    const first = await closeDeliveryInvoiceAction('offline-sale-a', 2.25);
    expect(first).toMatchObject({ success: false, error: 'IPC reply lost AFTER synthetic SQLite COMMIT' });
    expect(totals(sqlite).receipts).toBe(1); // Commit persisted despite transport failure.
    offlineConfirm = false;
    const second = await closeDeliveryInvoiceAction('offline-sale-a', 2.25);
    expect(second).toEqual({ success: true });
    expect(writeCalls).toBe(2); // Explicit same-nonce retry: native rejects duplicate; no second posting.
    expect(confirmCalls).toBe(2);
    expect((globalThis.crypto.randomUUID as jest.Mock)).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls.filter(([command]) => command === 'collect_delivery_native')
      .map(([, args]) => args.payload.requestId)).toEqual([NONCE, NONCE]);
    expect(totals(sqlite)).toMatchObject({ receipts: 1, movements: 1, journals: 1,
      entries: 3, activity: 1 });
  });

  it('refuses wrong actor, tenant, nonce, fee and sale even if a real 045 receipt exists', async () => {
    const original = { saleId: 'offline-sale-a', deliveryFee: 2.25, requestId: NONCE };
    postSimulatedNative(sqlite, 'owner-a', original);
    expect(confirmUsingNativeSql(sqlite, 'owner-a', original)).toMatchObject({
      id: `delivery-${NONCE}`, collectedAmount: 22.25,
    });
    expect(confirmUsingNativeSql(sqlite, 'owner-b', original)).toBeNull();
    expect(confirmUsingNativeSql(sqlite, 'owner-a', { ...original, requestId: OTHER_NONCE })).toBeNull();
    expect(confirmUsingNativeSql(sqlite, 'owner-a', { ...original, saleId: 'other-sale' })).toBeNull();
    expect(confirmUsingNativeSql(sqlite, 'owner-a', { ...original, deliveryFee: 2.26 })).toBeNull();
    expect(totals(sqlite).receipts).toBe(1);
  });

  it('blocks orphan/foreign sources and nonce conflicts without any detached cash or journal rows', async () => {
    const current = { saleId: 'offline-sale-a', deliveryFee: 2.25, requestId: NONCE };
    expect(() => postSimulatedNative(sqlite, 'owner-b', current)).toThrow('Verified native delivery source required');
    sqlite.prepare(`INSERT INTO sales_invoices VALUES('orphan-sale','owner-a','A','completed','delivery',10)`)
      .run();
    expect(() => postSimulatedNative(sqlite, 'owner-a', { ...current, saleId: 'orphan-sale', requestId: OTHER_NONCE }))
      .toThrow('Verified native delivery source required');
    expect(totals(sqlite)).toMatchObject({ receipts: 0, movements: 0, journals: 0 });
    postSimulatedNative(sqlite, 'owner-a', current);
    expect(() => postSimulatedNative(sqlite, 'owner-a', { ...current, requestId: OTHER_NONCE }))
      .toThrow('Delivery already collected or nonce reused');
    expect(() => postSimulatedNative(sqlite, 'owner-a', { ...current, saleId: 'orphan-sale', requestId: OTHER_NONCE }))
      .toThrow('Verified native delivery source required');
    expect(totals(sqlite)).toMatchObject({ receipts: 1, movements: 1, journals: 1, entries: 3 });
  });

  it('rolls back a committed-intent attempt when a final audit insert fails, then retries with same nonce', async () => {
    injectLateFailure = true;
    const first = await closeDeliveryInvoiceAction('offline-sale-a', 2.25);
    expect(first.success).toBe(false);
    expect(totals(sqlite)).toMatchObject({ receipts: 0, movements: 0, journals: 0,
      entries: 0, activity: 0, originalEntries: 2 });
    expect(sqlite.prepare('SELECT status FROM sales_invoices WHERE id=?')
      .get('offline-sale-a')).toEqual({ status: 'completed' });
    sqlite.exec('DROP TRIGGER synthetic_activity_failure');
    injectLateFailure = false;
    expect(await closeDeliveryInvoiceAction('offline-sale-a', 2.25)).toEqual({ success: true });
    expect((globalThis.crypto.randomUUID as jest.Mock)).toHaveBeenCalledTimes(1);
    expect(totals(sqlite)).toMatchObject({ receipts: 1, movements: 1, journals: 1, entries: 3 });
  });

  it('persists the ORIGINAL nonce before native write and confirms after module reload without reposting committed cash', async () => {
    dropWriteAck = true;
    offlineConfirm = true;
    expect((await closeDeliveryInvoiceAction('offline-sale-a', 2.25)).success).toBe(false);
    expect(writeCalls).toBe(1);
    expect(confirmCalls).toBe(1);
    const initialIntent = Array.from(savedIntents.values());
    expect(initialIntent).toHaveLength(1);
    expect(initialIntent[0]).toContain(NONCE);

    // A JS module re-import models an application page reload. SQLite is the
    // same disposable memory handle; this is NOT an actual OS/process restart.
    jest.resetModules();
    const reloaded = await import('../delivery');
    offlineConfirm = false;
    expect(await reloaded.closeDeliveryInvoiceAction('offline-sale-a', 2.25)).toEqual({ success: true });
    expect(writeCalls).toBe(1); // Strict native confirmation is read-only FIRST.
    expect(confirmCalls).toBe(2);
    expect(savedIntents.size).toBe(0);
    expect((globalThis.crypto.randomUUID as jest.Mock)).toHaveBeenCalledTimes(1);
    expect(totals(sqlite)).toMatchObject({ receipts: 1, movements: 1, journals: 1, entries: 3 });
  });

  it('keeps the original nonce and blocks writes when post-reload native confirmation is offline', async () => {
    dropWriteAck = true;
    offlineConfirm = true;
    expect((await closeDeliveryInvoiceAction('offline-sale-a', 2.25)).success).toBe(false);
    jest.resetModules();
    const reloaded = await import('../delivery');
    const result = await reloaded.closeDeliveryInvoiceAction('offline-sale-a', 2.25);
    expect(result).toMatchObject({ success: false });
    expect(writeCalls).toBe(1);
    expect(confirmCalls).toBe(2);
    expect(savedIntents.size).toBe(1);
    expect((globalThis.crypto.randomUUID as jest.Mock)).toHaveBeenCalledTimes(1);
    expect(totals(sqlite).receipts).toBe(1);
  });

  it('refuses to replace an unresolved original nonce when the collection fee changes', async () => {
    dropWriteAck = true;
    offlineConfirm = true;
    expect((await closeDeliveryInvoiceAction('offline-sale-a', 2.25)).success).toBe(false);
    const pending = Array.from(savedIntents.values());
    const changed = await closeDeliveryInvoiceAction('offline-sale-a', 3.25);
    expect(changed).toMatchObject({ success: false });
    expect(writeCalls).toBe(1);
    expect(confirmCalls).toBe(1);
    expect(Array.from(savedIntents.values())).toEqual(pending);
    jest.resetModules();
    const reloaded = await import('../delivery');
    expect((await reloaded.closeDeliveryInvoiceAction('offline-sale-a', 3.25)).success).toBe(false);
    expect(writeCalls).toBe(1);
    expect((globalThis.crypto.randomUUID as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  it('fails BEFORE any financial IPC write when durable pending-intent storage is unavailable', async () => {
    failStorageWrite = true;
    expect((await closeDeliveryInvoiceAction('offline-sale-a', 2.25)).success).toBe(false);
    expect(writeCalls).toBe(0);
    expect(confirmCalls).toBe(0);
    expect(totals(sqlite)).toMatchObject({ receipts: 0, movements: 0, journals: 0 });
  });

  it('coalesces overlapping same-sale collection clicks into a single native write', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const realIpc = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation(async (command: string, args: { payload: Payload }) => {
      if (command === 'collect_delivery_native') await gate;
      return realIpc(command, args);
    });
    const first = closeDeliveryInvoiceAction('offline-sale-a', 2.25);
    const second = closeDeliveryInvoiceAction('offline-sale-a', 2.25);
    const changed = closeDeliveryInvoiceAction('offline-sale-a', 9.99);
    release();
    expect(await first).toEqual({ success: true });
    expect(await second).toEqual({ success: true });
    expect((await changed).success).toBe(false);
    expect(writeCalls).toBe(1);
    expect(confirmCalls).toBe(0);
    expect(totals(sqlite).receipts).toBe(1);
  });

  it('never treats a NULL recovered receipt for a DIFFERENT logged-in actor as permission to post', async () => {
    dropWriteAck = true;
    offlineConfirm = true;
    expect((await closeDeliveryInvoiceAction('offline-sale-a', 2.25)).success).toBe(false);
    expect(totals(sqlite).receipts).toBe(1);

    jest.resetModules();
    const afterReload = await import('../delivery');
    actor = 'owner-b'; // Tenant B cannot confirm the original A receipt.
    offlineConfirm = false;
    expect((await afterReload.closeDeliveryInvoiceAction('offline-sale-a', 2.25)).success).toBe(false);
    expect(writeCalls).toBe(1);
    expect(confirmCalls).toBe(2);
    expect(savedIntents.size).toBe(1);

    actor = 'owner-a';
    expect(await afterReload.closeDeliveryInvoiceAction('offline-sale-a', 2.25)).toEqual({ success: true });
    expect(writeCalls).toBe(1); // A repeated read, never a financial replay.
    expect(confirmCalls).toBe(3);
    expect(savedIntents.size).toBe(0);
  });

  it('does not post when a previous nonce was persisted but strict native confirmation returns NULL', async () => {
    dropWriteAck = true;
    offlineConfirm = true;
    expect((await closeDeliveryInvoiceAction('offline-sale-a', 2.25)).success).toBe(false);
    const rawIntent = Array.from(savedIntents.values())[0];
    jest.resetModules();
    const afterReload = await import('../delivery');
    offlineConfirm = false;
    const native = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation(async (command: string, args: { payload: Payload }) => {
      if (command === 'confirm_delivery_collection_native') {
        confirmCalls += 1;
        return null; // A NULL proof is NOT evidence it is safe to write.
      }
      return native(command, args);
    });
    expect((await afterReload.closeDeliveryInvoiceAction('offline-sale-a', 2.25)).success).toBe(false);
    expect(writeCalls).toBe(1);
    expect(confirmCalls).toBe(2);
    expect(Array.from(savedIntents.values())).toEqual([rawIntent]);
    expect(totals(sqlite)).toMatchObject({ receipts: 1, movements: 1, journals: 1 });
  });

  it.each(['malformed JSON', 'fake foreign proof fields', 'valid-shape tampered nonce'])(
    'rejects an untrusted stored pending intent (%s) without posting', async variant => {
      const key = 'pharma.delivery.collection.pending.v1:offline-sale-a';
      const validShape = { version: 1, saleId: 'offline-sale-a', feeCents: 225, requestId: NONCE };
      const corrupted = variant === 'malformed JSON' ? '{' : JSON.stringify(
        variant === 'fake foreign proof fields'
          ? { ...validShape, tenant: 'forged', actorId: 'forged' }
          : { ...validShape, requestId: 'not-a-canonical-uuid' },
      );
      savedIntents.set(key, corrupted);
      expect((await closeDeliveryInvoiceAction('offline-sale-a', 2.25)).success).toBe(false);
      expect(writeCalls).toBe(0);
      expect(confirmCalls).toBe(0);
      expect(savedIntents.get(key)).toBe(corrupted);
      expect((globalThis.crypto.randomUUID as jest.Mock)).not.toHaveBeenCalled();
      expect(totals(sqlite).receipts).toBe(0);
    },
  );

  it('simulates two independently loaded renderer modules sharing storage but still only one SQLite posting', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const actualIpc = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation(async (command: string, args: { payload: Payload }) => {
      if (command === 'collect_delivery_native') await gate;
      return actualIpc(command, args);
    });

    const firstWindow = closeDeliveryInvoiceAction('offline-sale-a', 2.25);
    jest.resetModules(); // A separate JS module; NOT two OS/browser processes.
    const secondWindowModule = await import('../delivery');
    const secondWindow = secondWindowModule.closeDeliveryInvoiceAction('offline-sale-a', 2.25);
    expect((await secondWindow).success).toBe(false); // Confirmed NULL while first write is still pending.
    release();
    expect(await firstWindow).toEqual({ success: true });
    expect(writeCalls).toBe(1);
    expect(confirmCalls).toBe(1);
    expect((globalThis.crypto.randomUUID as jest.Mock)).toHaveBeenCalledTimes(1);
    expect(totals(sqlite)).toMatchObject({ receipts: 1, movements: 1, journals: 1, entries: 3 });
  });
});
