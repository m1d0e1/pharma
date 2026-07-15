const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '../pharma_local.db');
const db = new Database(dbPath);

console.log('Seeding 200 drugs into inventory...');

try {
  // Get 200 drugs from master_drugs
  const drugs = db.prepare('SELECT id, official_price, trade_name FROM master_drugs ORDER BY id LIMIT 200').all();
  
  if (drugs.length === 0) {
    console.error('No master drugs found in database. Run seed:db first.');
    process.exit(1);
  }

  // Clear existing inventory
  db.prepare("DELETE FROM inventory WHERE pharmacy_id = 'local_default'").run();

  const insertStmt = db.prepare(`
    INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, local_selling_price, expiry_date, barcode, strips_per_box)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  const insertMany = db.transaction(() => {
    for (const drug of drugs) {
      const id = `inv-seed-${drug.id}`;
      const pharmacy_id = 'local_default';
      const drug_id = drug.id;
      const quantity = Math.floor(Math.random() * 80) + 10; // 10 to 90
      const local_selling_price = drug.official_price > 0 ? drug.official_price : Math.floor(Math.random() * 100) + 10;
      const expiry_date = `2027-0${Math.floor(Math.random() * 8) + 1}-15`; // Random date in 2027
      const barcode = null;
      const strips_per_box = 3;

      insertStmt.run(id, pharmacy_id, drug_id, quantity, local_selling_price, expiry_date, barcode, strips_per_box);
      count++;
    }
  });

  insertMany();
  console.log(`Successfully seeded ${count} inventory items!`);
} catch (e) {
  console.error('Failed to seed inventory:', e);
}
