import { getDatabase } from './src/lib/db/client';
import { initLocalDb } from './src/lib/db/local';

const db = initLocalDb();
try {
  // Try inserting using the same query as addInventoryAction
  const id = 'test-uuid-12345';
  const pharmacy_id = 'local_default';
  const drug_id = 18;
  const quantity = 33;
  const local_selling_price = 237;
  const expiry_date = '2026-06-26';
  const barcode = null;

  db.prepare(`
    INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, local_selling_price, expiry_date, barcode)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, pharmacy_id || null, drug_id, quantity, local_selling_price, expiry_date, barcode || null);
  
  console.log('Insert successful!');
} catch (e: any) {
  console.error('Insert failed with error:', e.message);
}
