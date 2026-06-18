import { initLocalDb } from './src/lib/db/local';

const db = initLocalDb();
try {
  const id = 'test-uuid-23456';
  const pharmacy_id = 'b395c3ce-4956-40f8-8bb9-49cd3f02f9a4';
  const drug_id = 18;
  const quantity = 33;
  const local_selling_price = 237;
  const expiry_date = '2026-06-26';
  const barcode = null;

  db.prepare(`
    INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, local_selling_price, expiry_date, barcode)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, pharmacy_id, drug_id, quantity, local_selling_price, expiry_date, barcode || null);
  
  console.log('Insert with pharmacy_id successful!');
} catch (e: any) {
  console.error('Insert with pharmacy_id failed:', e.message);
}
