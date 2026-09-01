import Database from 'better-sqlite3';
import { readFileSync } from 'fs';

let mockDb: Database.Database;
let mockId = 0;

jest.mock('@/lib/db/tauri', () => {
  const original = jest.requireActual('@/lib/db/tauri');
  return {
    ...original,
    dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
    dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) || null),
    dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
      const result = mockDb.prepare(sql).run(...params);
      return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
    }),
    dbTransaction: jest.fn(async (callback: () => unknown) => callback()),
    generateId: jest.fn(() => `test-id-${++mockId}`),
  };
});

let mockSession: any = { id: 'admin', role: 'owner', pharmacy_id: null };

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  getClientSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: jest.fn(() => true),
  verifyPassword: jest.fn(async () => true),
}));

jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: {
    load: jest.fn(async () => undefined),
    getAllDrugs: jest.fn(() => []),
    updateDrug: jest.fn(),
    enrich: jest.fn((rows: unknown[]) => rows),
  },
}));

jest.mock('@/lib/env', () => ({ isTauri: false }));
jest.unmock('@/app/actions-client/inventory');
jest.unmock('@/app/actions-client/shortages');
jest.unmock('@/app/actions-client/purchases');
jest.unmock('@/app/actions-client/sales');
jest.unmock('@/app/actions-client/handover');
jest.unmock('@/app/actions-client/shifts');
jest.unmock('@/app/actions-client/returns');
jest.unmock('@/app/actions-client/finance');

import { normalizeDatabaseTimestamps } from '@/lib/db/tauri';
import {
  createPurchaseInvoiceAction,
  completePurchaseInvoiceAction,
  updateCompletedPurchaseInvoiceAction,
  createPurchaseReturnAction,
} from '@/app/actions-client/purchases';
import {
  addToShortagesAction,
  getShortagesAction,
} from '@/app/actions-client/shortages';
import { getLowStockAction } from '@/app/actions-client/inventory';
import { processCheckoutAction } from '@/app/actions-client/sales';
import { openShiftAction, getCurrentShiftAction } from '@/app/actions-client/shifts';
import { processHandoverAction } from '@/app/actions-client/handover';
import { createReturnAction } from '@/app/actions-client/returns';
import {
  addBankAction,
  updateBankAction,
  deleteBankAction,
  getBanksAction,
  addCardAction,
  getCardsAction,
  addPointOfSaleAction,
  getPointsOfSaleAction,
  addPaperAction,
  getPapersAction,
  updatePaperStatusAction,
  createManualJournalAction,
  getJournalsAction,
  saveTrialBalanceSettingAction,
} from '@/app/actions-client/finance';

function applyAllMigrations(db: Database.Database) {
  const files = [
    '001_initial.sql',
    '002_performance.sql',
    '003_sync_metadata.sql',
    '004_return_items_patch.sql',
    '005_purchase_return_details.sql',
    '006_accounting_upgrade_seed.sql',
    '007_purchase_inventory_links.sql',
    '008_patient_accounting.sql',
    '009_rebuild_master_drugs_fts.sql',
    '010_shift_handover_indexes.sql',
    '011_shift_cash_difference_account.sql',
    '012_shortages_pharmacy_scope.sql',
    '013_shift_handover_details.sql',
    '014_inventory_performance.sql',
  ];
  for (const file of files) {
    const sql = readFileSync(`src-tauri/migrations/${file}`, 'utf8');
    db.exec(sql);
  }
}

function applyLocalSchemaRepairs(db: Database.Database) {
  const addCol = (table: string, col: string, typeDef: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
    if (!cols.some(c => c.name === col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${typeDef}`);
    }
  };

  addCol('shortages', 'pharmacy_id', "TEXT NOT NULL DEFAULT 'local_default'");
  addCol('shortages', 'requested_quantity', 'REAL DEFAULT 1');
  addCol('shortages', 'status', "TEXT DEFAULT 'pending'");
  addCol('shortages', 'priority', "TEXT DEFAULT 'normal'");
  addCol('shortages', 'notes', 'TEXT');
  addCol('shortages', 'created_at', 'DATETIME');
  addCol('purchase_invoice_items', 'barcode', 'TEXT');
  addCol('shifts', 'receiver_id', 'TEXT');
  addCol('shifts', 'actual_cash', 'REAL');
  addCol('shifts', 'transfer_amount', 'REAL DEFAULT 0');
  addCol('shifts', 'transfer_target', "TEXT DEFAULT 'vault'");
  addCol('shifts', 'cash_difference', 'REAL DEFAULT 0');
  addCol('cash_movements', 'source_type', 'TEXT');
  addCol('cash_movements', 'target_name', 'TEXT');

  db.exec('CREATE INDEX IF NOT EXISTS idx_shortages_pharmacy_drug_status ON shortages(pharmacy_id, drug_id, status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_shortages_pharmacy_status ON shortages(pharmacy_id, status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_shortages_drug_id ON shortages(drug_id)');
  db.exec("UPDATE shortages SET pharmacy_id = 'local_default' WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id) = ''");
  db.exec('UPDATE shortages SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL');
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS shortages_set_created_at
    AFTER INSERT ON shortages
    WHEN NEW.created_at IS NULL
    BEGIN
      UPDATE shortages SET created_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END
  `);
}

function seedBaselineEntities(db: Database.Database) {
  db.exec(`
    INSERT OR IGNORE INTO users (id, username, password_hash, role, full_name, is_active)
    VALUES
      ('admin', 'admin', 'hash', 'owner', 'مدير النظام', 1),
      ('pharmacist1', 'pharmacist1', 'hash', 'pharmacist', 'دكتور الصيدلية', 1);

    INSERT OR IGNORE INTO suppliers (id, name_ar, balance)
    VALUES (1, 'شركة الأدوية المتحدة', 0);

    INSERT OR IGNORE INTO patients (id, full_name, credit_limit)
    VALUES
      ('cash', 'عميل نقدي', 0),
      ('patient-1', 'أحمد محمود', 500);

    INSERT OR IGNORE INTO accounts (id, code, name_ar, type, balance, is_group)
    VALUES
      (1, '1.1.1', 'الصندوق (الخزينة النقدية)', 'asset', 0, 0),
      (2, '1.1.2', 'البنك', 'asset', 0, 0),
      (3, '1.1.3', 'الخزينة الرئيسية (العهد)', 'asset', 0, 0),
      (4, '1.2.1', 'المخزون', 'asset', 0, 0),
      (5, '2.1.1', 'الموردين', 'liability', 0, 0),
      (6, '4.1.1', 'المبيعات', 'revenue', 0, 0),
      (7, '4.1.2', 'مردودات المبيعات', 'revenue', 0, 0),
      (8, '5.1.1', 'تكلفة البضاعة المباعة', 'expense', 0, 0),
      (9, '5.3.1', 'عجز النقدية', 'expense', 0, 0),
      (10, '4.3.1', 'زيادة النقدية', 'revenue', 0, 0);

    INSERT OR IGNORE INTO banks (id, name_ar, name_en, account_number, current_balance)
    VALUES (1, 'بنك التجاري الدولي', 'CIB Bank', '123456', 5000);

    INSERT OR IGNORE INTO master_drugs (
      id, trade_name, trade_name_en, reorder_point, default_purchase_qty,
      large_to_medium, medium_to_small, medium_unit, small_unit, barcode
    ) VALUES
      (5001, 'بانادول اكسترا', 'Panadol Extra', 10, 20, 2, 12, 'شريط', 'قرص', '62210001'),
      (5002, 'كونجستال اقراص', 'Congestal Tab', 5, 10, 2, 10, 'شريط', 'قرص', '62210002');
  `);
}

describe('Cross-computer consistency across fresh install and update', () => {
  beforeEach(() => {
    mockId = 0;
    mockSession = { id: 'admin', role: 'owner', pharmacy_id: null };
  });

  afterEach(() => {
    if (mockDb) mockDb.close();
  });

  it('behaves identically on a FRESH installation', async () => {
    mockDb = new Database(':memory:');
    applyAllMigrations(mockDb);
    seedBaselineEntities(mockDb);

    // 1. Open shift
    const openShiftRes = await openShiftAction({ starting_cash_amount: 100 });
    expect(openShiftRes.success).toBe(true);
    const shift = (await getCurrentShiftAction()).data;
    expect(shift).toBeDefined();
    expect(shift?.status).toBe('open');

    // 2. Shortage & Low Stock Alert for Drug 5001 (initially 0 stock, reorder=10)
    await addToShortagesAction({ drug_id: 5001, qty: 15 });
    const shortagesBefore = (await getShortagesAction()).data || [];
    expect(shortagesBefore.some((s: any) => s.drug_id === 5001)).toBe(true);

    const lowStockBefore = await getLowStockAction(10);
    expect(lowStockBefore.data?.some((d: any) => d.id === 5001)).toBe(true);

    // 3. Purchase invoice: buy 20 boxes of 5001 (exceeds reorder_point)
    const purchaseRes = await createPurchaseInvoiceAction({
      supplier_id: 1,
      invoice_number: 'INV-FRESH-01',
      invoice_date: '2026-08-30',
      payment_method: 'credit',
      status: 'completed',
      cart: [
        {
          id: 5001,
          quantity: 20,
          cost_price: 30,
          selling_price: 40,
          expiry_date: '2029-12-31',
          strips_per_box: 2,
          barcode: '62210001',
        },
      ],
    });
    expect(purchaseRes.success).toBe(true);

    // 4. Verify Shortages marked received & removed from active list
    const shortagesAfter = (await getShortagesAction()).data || [];
    expect(shortagesAfter.some((s: any) => s.drug_id === 5001)).toBe(false);
    const shortageRow = mockDb.prepare('SELECT status FROM shortages WHERE drug_id = 5001').get() as any;
    expect(shortageRow.status).toBe('received');

    // 5. Verify Low Stock Alert cleared (stock is 20 > 10)
    const lowStockAfter = await getLowStockAction(10);
    expect(lowStockAfter.data?.some((d: any) => d.id === 5001)).toBe(false);

    // 6. Sell 2 boxes via POS
    const invRow = mockDb.prepare('SELECT id FROM inventory WHERE drug_id = 5001').get() as any;
    const checkoutRes = await processCheckoutAction({
      items: [
        {
          drug_id: 5001,
          inventory_id: invRow.id,
          quantity_sold: 2,
          unit_price: 40,
          selected_unit: 'large',
        },
      ],
      payment_method: 'cash',
      total_discount: 0,
    });
    expect(checkoutRes.success).toBe(true);

    // Verify stock is now 18
    const stockAfterSale = mockDb.prepare('SELECT quantity FROM inventory WHERE drug_id = 5001').get() as any;
    expect(stockAfterSale.quantity).toBe(18);

    // 7. Perform Sales Return (1 box) associated with the current shift
    const saleId = checkoutRes.data?.sale_id;
    expect(saleId).toBeDefined();
    const soldItem = mockDb.prepare('SELECT id FROM sales_items WHERE invoice_id = ?').get(saleId) as any;
    expect(soldItem).toBeDefined();

    const returnRes = await createReturnAction({
      invoice_id: saleId,
      shift_id: shift!.id,
      items: [
        {
          sale_item_id: soldItem.id,
          drug_name: 'بانادول اكسترا',
          inventory_id: invRow.id,
          quantity: 1,
          unit_price: 40,
          unit: 'large',
        },
      ],
      refund_method: 'cash',
      reason: 'طلب العميل إرجاع علبة',
    });
    expect(returnRes.success).toBe(true);

    // Verify stock is now 19
    const stockAfterReturn = mockDb.prepare('SELECT quantity FROM inventory WHERE drug_id = 5001').get() as any;
    expect(stockAfterReturn.quantity).toBe(19);

    // 8. Handover keeps the permanent user session open.
    const handoverRes = await processHandoverAction({
      shiftId: shift!.id,
      actualCash: 140, // 100 starting + 80 sale - 40 refund = 140 expected.
      transferAmount: 100,
      transferTargetId: 'vault',
      transferTargetType: 'treasury',
      receiverUsername: 'admin',
      receiverPasswordHash: 'hash',
    });
    expect(handoverRes.success).toBe(true);
    expect(handoverRes.difference).toBe(0);
    expect(handoverRes.remainingCash).toBe(40);

    const permanentShift = mockDb.prepare('SELECT * FROM shifts WHERE id = ?').get(shift!.id) as any;
    expect(permanentShift.status).toBe('open');
    expect(permanentShift.actual_cash).toBe(140);
    expect(permanentShift.cash_difference).toBe(0);

    // 9. Financial Module Full Dynamic Operations on Fresh Install
    const addBankRes = await addBankAction({
      name_ar: 'بنك مصر',
      name_en: 'Banque Misr',
      account_number: '987654321',
      branch: 'الفرع الرئيسي',
      current_balance: 10000,
    });
    expect(addBankRes.success).toBe(true);
    const banks = (await getBanksAction()).data || [];
    expect(banks.some((b: any) => b.name_ar === 'بنك مصر')).toBe(true);

    const addCardRes = await addCardAction({
      name_ar: 'ماكينة فوري كاشير 1',
      bank_id: Number(addBankRes.id),
      commission_pct: 1.5,
      current_balance: 0,
    });
    expect(addCardRes.success).toBe(true);
    const cards = (await getCardsAction()).data || [];
    expect(cards.some((c: any) => c.name_ar === 'ماكينة فوري كاشير 1')).toBe(true);

    const addPosRes = await addPointOfSaleAction({
      name_ar: 'كاشير الصالة 1',
      name_en: 'POS-01',
      location: 'الصالة الرئيسية',
      computer_name: 'PC-01',
    });
    expect(addPosRes.success).toBe(true);
    const posList = (await getPointsOfSaleAction()).data || [];
    expect(posList.some((p: any) => p.name_ar === 'كاشير الصالة 1')).toBe(true);

    const addPaperRes = await addPaperAction({
      type: 'check',
      direction: 'in',
      paper_number: 'CHK-9988',
      bank_id: Number(addBankRes.id),
      amount: 1500,
      due_date: '2026-09-15',
      target_name: 'صيدلية الأمل',
    });
    expect(addPaperRes.success).toBe(true);
    const paperId = addPaperRes.id!;
    const papers = (await getPapersAction()).data || [];
    expect(papers.some((p: any) => p.id === paperId)).toBe(true);

    const cashPaperRes = await updatePaperStatusAction(paperId, 'cashed', '2026-09-01');
    expect(cashPaperRes.success).toBe(true);
    const cashedPaper = mockDb.prepare('SELECT status FROM commercial_papers WHERE id = ?').get(paperId) as any;
    expect(cashedPaper.status).toBe('cashed');
    expect(mockDb.prepare("SELECT source_type, target_name FROM cash_movements WHERE category = 'collection' AND target_name = ?").get(paperId)).toMatchObject({
      source_type: 'commercial_paper',
      target_name: paperId,
    });
    expect(await updatePaperStatusAction(paperId, 'bounced')).toMatchObject({
      success: false,
      error: expect.stringContaining('قيد عكسي'),
    });
    expect((mockDb.prepare('SELECT status FROM commercial_papers WHERE id = ?').get(paperId) as any).status).toBe('cashed');

    const journalRes = await createManualJournalAction({
      date: '2026-09-01',
      description: 'تسوية نقدية يدوية',
      entries: [
        { account_id: 6, type: 'debit', amount: 500, notes: 'زيادة نقدية' },
        { account_id: 9, type: 'credit', amount: 500, notes: 'إيراد تسوية' },
      ],
    });
    expect(journalRes.success).toBe(true);
    const journals = (await getJournalsAction()).data || [];
    expect(journals.some((j: any) => j.description === 'تسوية نقدية يدوية')).toBe(true);
  });

  it('behaves identically on an UPDATE / UPGRADE installation', async () => {
    mockDb = new Database(':memory:');
    // Start with ONLY initial schema (no newer migrations applied yet)
    mockDb.exec(readFileSync('src-tauri/migrations/001_initial.sql', 'utf8'));

    // Apply incremental schema repairs (simulating local.ts update logic)
    applyLocalSchemaRepairs(mockDb);
    seedBaselineEntities(mockDb);

    // 1. Open shift
    const openShiftRes = await openShiftAction({ starting_cash_amount: 100 });
    expect(openShiftRes.success).toBe(true);
    const shift = (await getCurrentShiftAction()).data;
    expect(shift).toBeDefined();
    expect(shift?.status).toBe('open');

    // 2. Shortage & Low Stock Alert for Drug 5002 (reorder=5, stock=0)
    await addToShortagesAction({ drug_id: 5002, qty: 10 });
    const shortagesBefore = (await getShortagesAction()).data || [];
    expect(shortagesBefore.some((s: any) => s.drug_id === 5002)).toBe(true);

    // 3. Purchase invoice on updated schema
    const purchaseRes = await createPurchaseInvoiceAction({
      supplier_id: 1,
      invoice_number: 'INV-UPDATE-01',
      invoice_date: '2026-08-30',
      payment_method: 'credit',
      status: 'completed',
      cart: [
        {
          id: 5002,
          quantity: 10,
          cost_price: 15,
          selling_price: 20,
          expiry_date: '2029-12-31',
          strips_per_box: 2,
          barcode: '62210002',
        },
      ],
    });
    expect(purchaseRes.success).toBe(true);

    // 4. Verify Shortages updated to 'received' on update installation
    const shortagesAfter = (await getShortagesAction()).data || [];
    expect(shortagesAfter.some((s: any) => s.drug_id === 5002)).toBe(false);
    const shortageRow = mockDb.prepare('SELECT status FROM shortages WHERE drug_id = 5002').get() as any;
    expect(shortageRow.status).toBe('received');

    // 5. Verify Low Stock Alert cleared (stock is 10 > 5)
    const lowStockAfter = await getLowStockAction(5);
    expect(lowStockAfter.data?.some((d: any) => d.id === 5002)).toBe(false);

    // 6. Sell 1 box via POS
    const invRow = mockDb.prepare('SELECT id FROM inventory WHERE drug_id = 5002').get() as any;
    const checkoutRes = await processCheckoutAction({
      items: [
        {
          drug_id: 5002,
          inventory_id: invRow.id,
          quantity_sold: 1,
          unit_price: 20,
          selected_unit: 'large',
        },
      ],
      payment_method: 'cash',
      total_discount: 0,
    });
    expect(checkoutRes.success).toBe(true);

    // 7. Close Shift with Handover
    const handoverRes = await processHandoverAction({
      shiftId: shift!.id,
      actualCash: 120, // 100 starting + 20 sale = 120
      transferAmount: 80,
      transferTargetId: 'vault',
      transferTargetType: 'treasury',
      receiverUsername: 'admin',
      receiverPasswordHash: 'hash',
    });
    expect(handoverRes.success).toBe(true);
    expect(handoverRes.difference).toBe(0);
    expect(handoverRes.remainingCash).toBe(40);

    // 8. Financial Module Full Dynamic Operations on Update Install
    const addBankRes = await addBankAction({
      name_ar: 'بنك مصر (تحديث)',
      name_en: 'Banque Misr Updated',
      account_number: '11223344',
      branch: 'فرع الدقي',
      current_balance: 7500,
    });
    expect(addBankRes.success).toBe(true);
    const banks = (await getBanksAction()).data || [];
    expect(banks.some((b: any) => b.name_ar === 'بنك مصر (تحديث)')).toBe(true);

    const addCardRes = await addCardAction({
      name_ar: 'ماكينة بنك مصر كاشير 2',
      bank_id: Number(addBankRes.id),
      commission_pct: 1.0,
      current_balance: 0,
    });
    expect(addCardRes.success).toBe(true);
    const cards = (await getCardsAction()).data || [];
    expect(cards.some((c: any) => c.name_ar === 'ماكينة بنك مصر كاشير 2')).toBe(true);

    const addPosRes = await addPointOfSaleAction({
      name_ar: 'كاشير الفرع 2',
      name_en: 'POS-02',
      location: 'الفرع الإضافي',
      computer_name: 'PC-02',
    });
    expect(addPosRes.success).toBe(true);
    const posList = (await getPointsOfSaleAction()).data || [];
    expect(posList.some((p: any) => p.name_ar === 'كاشير الفرع 2')).toBe(true);

    const addPaperRes = await addPaperAction({
      type: 'promissory_note',
      direction: 'out',
      paper_number: 'NOTE-7766',
      bank_id: Number(addBankRes.id),
      amount: 3000,
      due_date: '2026-10-01',
      target_name: 'شركة توزيع الأدوية',
    });
    expect(addPaperRes.success).toBe(true);
    const paperId = addPaperRes.id!;
    const papers = (await getPapersAction()).data || [];
    expect(papers.some((p: any) => p.id === paperId)).toBe(true);

    const cashPaperRes = await updatePaperStatusAction(paperId, 'cashed', '2026-09-01');
    expect(cashPaperRes.success).toBe(true);
    const cashedPaper = mockDb.prepare('SELECT status FROM commercial_papers WHERE id = ?').get(paperId) as any;
    expect(cashedPaper.status).toBe('cashed');

    const journalRes = await createManualJournalAction({
      date: '2026-09-01',
      description: 'تسوية رصيد بنكي في التحديث',
      entries: [
        { account_id: 8, type: 'debit', amount: 1000, notes: 'إيداع بنكي' },
        { account_id: 6, type: 'credit', amount: 1000, notes: 'صرف من الخزينة' },
      ],
    });
    expect(journalRes.success).toBe(true);
    const journals = (await getJournalsAction()).data || [];
    expect(journals.some((j: any) => j.description === 'تسوية رصيد بنكي في التحديث')).toBe(true);
  });

  it('tests advanced feature options: purchase draft completion, edit, returns, and next-shift handover', async () => {
    mockDb = new Database(':memory:');
    applyAllMigrations(mockDb);
    seedBaselineEntities(mockDb);

    await openShiftAction({ starting_cash_amount: 50 });
    const shift = (await getCurrentShiftAction()).data;

    // A. Purchase Draft Creation -> Complete Draft
    await addToShortagesAction({ drug_id: 5001, qty: 10 });
    const draftRes = await createPurchaseInvoiceAction({
      supplier_id: 1,
      invoice_number: 'INV-DRAFT-01',
      invoice_date: '2026-08-30',
      payment_method: 'credit',
      status: 'draft',
      cart: [
        {
          id: 5001,
          quantity: 10,
          cost_price: 25,
          selling_price: 35,
          expiry_date: '2028-12-31',
          strips_per_box: 2,
        },
      ],
    });
    expect(draftRes.success).toBe(true);
    // While draft, shortage is still pending
    const draftShortage = mockDb.prepare('SELECT status FROM shortages WHERE drug_id = 5001').get() as any;
    expect(draftShortage.status).toBe('pending');

    // Complete the draft
    const completeRes = await completePurchaseInvoiceAction(draftRes.id!);
    expect(completeRes.success).toBe(true);
    const completedShortage = mockDb.prepare('SELECT status FROM shortages WHERE drug_id = 5001').get() as any;
    expect(completedShortage.status).toBe('received');

    // B. Unit options: sell 1 strip (medium unit) instead of whole box
    const invRow = mockDb.prepare('SELECT id, quantity FROM inventory WHERE drug_id = 5001').get() as any;
    expect(invRow.quantity).toBe(10);

    const stripSaleRes = await processCheckoutAction({
      items: [
        {
          drug_id: 5001,
          inventory_id: invRow.id,
          quantity_sold: 1,
          unit_price: 17.5,
          selected_unit: 'medium', // 1 strip from 2 strips/box = 0.5 box
        },
      ],
      payment_method: 'cash',
      total_discount: 0,
    });
    expect(stripSaleRes.success).toBe(true);

    const invAfterStrip = mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get(invRow.id) as any;
    expect(invAfterStrip.quantity).toBeCloseTo(9.5, 4); // Exactly 9.5 boxes left!

    // C. Credit sale option: sell to patient on account
    const creditSaleRes = await processCheckoutAction({
      items: [
        {
          drug_id: 5001,
          inventory_id: invRow.id,
          quantity_sold: 1,
          unit_price: 35,
          selected_unit: 'large',
        },
      ],
      patient_id: 'patient-1',
      payment_method: 'credit',
      total_discount: 0,
    });
    expect(creditSaleRes.success).toBe(true);

    // Sales invoice recorded with credit payment method
    const creditSale = mockDb.prepare("SELECT total_amount, payment_method FROM sales_invoices WHERE patient_id = 'patient-1'").get() as any;
    expect(creditSale.total_amount).toBe(35);
    expect(creditSale.payment_method).toBe('credit');

    // D. Old auto-open requests are idempotent under the permanent-session model.
    // Cash in drawer = 50 starting + 17.5 strip sale (cash) = 67.5 (credit sale is 0 cash).
    // Transfer 50 to treasury, remaining in drawer = 17.5 for next shift.
    const nextShiftHandover = await processHandoverAction({
      shiftId: shift!.id,
      actualCash: 67.5,
      transferAmount: 50,
      transferTargetId: 'vault',
      transferTargetType: 'treasury',
      receiverUsername: 'pharmacist1',
      receiverPasswordHash: 'hash',
      autoOpenNewShift: true,
    });
    expect(nextShiftHandover.success).toBe(true);
    expect(nextShiftHandover.difference).toBe(0);
    expect(nextShiftHandover.remainingCash).toBe(17.5);

    // Verify the same session remains open and carries 17.5 as its computed balance.
    const nextShift = mockDb.prepare("SELECT * FROM shifts WHERE user_id = 'admin' AND status = 'open'").get() as any;
    expect(nextShift).toBeDefined();
    expect(nextShift.starting_cash).toBe(50);
    expect((mockDb.prepare("SELECT COUNT(*) AS total FROM shifts WHERE user_id = 'admin'").get() as any).total).toBe(1);
  });

  it('normalizes timestamps consistently across all computer timezones and string formats', () => {
    // 1. SQLite standard format: 'YYYY-MM-DD HH:mm:ss'
    const rows1 = [{ id: 1, created_at: '2026-08-30 15:30:00', total_amount: 100 }];
    const norm1 = normalizeDatabaseTimestamps(rows1);
    expect(norm1[0].created_at).toBe('2026-08-30T15:30:00Z');

    // 2. Already normalized ISO string with Z
    const rows2 = [{ id: 2, created_at: '2026-08-30T15:30:00Z' }];
    const norm2 = normalizeDatabaseTimestamps(rows2);
    expect(norm2[0].created_at).toBe('2026-08-30T15:30:00Z');

    // 3. Null or undefined timestamps
    const rows3 = [{ id: 3, created_at: null, updated_at: undefined }];
    const norm3 = normalizeDatabaseTimestamps(rows3);
    expect(norm3[0].created_at).toBeNull();
    expect(norm3[0].updated_at).toBeUndefined();

    // 4. Verify JavaScript Date parses the normalized timestamp to accurate UTC time
    const parsedDate = new Date(norm1[0].created_at);
    expect(isNaN(parsedDate.getTime())).toBe(false);
    expect(parsedDate.getUTCFullYear()).toBe(2026);
    expect(parsedDate.getUTCMonth()).toBe(7); // 0-indexed August
    expect(parsedDate.getUTCDate()).toBe(30);
    expect(parsedDate.getUTCHours()).toBe(15);
    expect(parsedDate.getUTCMinutes()).toBe(30);
  });

  it('keeps separate trial-balance mappings for every bank, POS, and expense entity', async () => {
    mockDb = new Database(':memory:');
    applyAllMigrations(mockDb);
    seedBaselineEntities(mockDb);

    expect((await saveTrialBalanceSettingAction({ category: 'bank', target_id: '1', target_name: 'بنك 1', account_id: 6 })).success).toBe(true);
    expect((await saveTrialBalanceSettingAction({ category: 'bank', target_id: '2', target_name: 'بنك 2', account_id: 7 })).success).toBe(true);

    const mappings = mockDb.prepare(`
      SELECT category, target_id, account_id
      FROM trial_balance_settings
      WHERE category LIKE 'bank:%'
      ORDER BY category
    `).all() as any[];

    expect(mappings).toEqual([
      { category: 'bank:1', target_id: '1', account_id: 6 },
      { category: 'bank:2', target_id: '2', account_id: 7 },
    ]);
  });

  it('prevents silent bank-balance edits and deletion of a non-zero account', async () => {
    mockDb = new Database(':memory:');
    applyAllMigrations(mockDb);
    seedBaselineEntities(mockDb);

    const created = await addBankAction({ name_ar: 'بنك اختباري', current_balance: 250 });
    expect(created.success).toBe(true);
    const bankId = Number(created.id);

    expect((await updateBankAction(bankId, { name_ar: 'بنك محدث', current_balance: 0 })).success).toBe(true);
    expect((mockDb.prepare('SELECT current_balance FROM banks WHERE id = ?').get(bankId) as any).current_balance).toBe(250);
    expect(await deleteBankAction(bankId)).toMatchObject({ success: false, error: expect.stringContaining('رصيد') });
  });
});
