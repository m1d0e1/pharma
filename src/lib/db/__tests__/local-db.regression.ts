jest.mock('@/scripts/importInteractions', () => ({ importInteractionsFromCSV: jest.fn() }));

describe('fresh local database bootstrap', () => {
  it('creates the current purchasing, inventory, sales, and return schema', () => {
    process.env.PHARMA_DB_PATH = ':memory:';
    delete (global as any).__db_initialized;
    jest.resetModules();

    const { getDatabase, closeDatabase } = require('../client');
    const db = getDatabase();
    const columns = (table: string) =>
      db.prepare(`PRAGMA table_info(${table})`).all().map((column: any) => column.name);

    expect(columns('master_drugs')).toEqual(expect.arrayContaining(['barcode', 'indications', 'side_effects']));
    expect(columns('purchase_invoices')).toContain('updated_at');
    expect(columns('purchase_invoice_items')).toEqual(expect.arrayContaining(['inventory_id', 'barcode', 'strips_per_box']));
    expect(columns('return_items')).toEqual(expect.arrayContaining(['sale_item_id', 'unit', 'drug_id', 'total_price']));
    expect(columns('purchase_return_items')).toEqual(expect.arrayContaining(['purchase_invoice_item_id', 'unit']));
    expect(columns('master_drugs_fts')).toEqual(expect.arrayContaining(['manufacturer', 'category']));
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });

    closeDatabase();
    delete (global as any).__db_initialized;
    delete process.env.PHARMA_DB_PATH;
  });
});
