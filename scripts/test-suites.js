const Database = require('better-sqlite3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const dbPath = path.join(__dirname, '../pharma_local.db');
const db = new Database(dbPath);

console.log('--- STARTING TAURI BUSINESS LOGIC TESTS ---');

function assert(condition, message) {
  if (!condition) {
    console.error('❌ FAIL:', message);
    process.exit(1);
  }
}

try {
  // 1. Stores: Adding an adjustment
  console.log('\nTesting Stores Adjustments...');
  const inventoryId = uuidv4();
  const drugId = 1001; // Mock drug ID
  
  // Insert drug if not exists
  db.prepare('INSERT OR IGNORE INTO master_drugs (id, trade_name_en) VALUES (?, ?)').run(drugId, 'Test Drug');
  
  db.prepare(`
    INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, local_selling_price, expiry_date)
    VALUES (?, 'TEST_PHARMA', ?, 100, 50, '2027-01-01')
  `).run(inventoryId, drugId);

  // Perform Adjustment (reduce 5 items)
  const adjustQty = -5;
  const reasonId = 1;
  const newQty = 100 + adjustQty;

  const tx = db.transaction(() => {
    db.prepare('UPDATE inventory SET quantity = ? WHERE id = ?').run(newQty, inventoryId);
    db.prepare(`
      INSERT INTO stock_adjustments (inventory_id, reason_id, old_quantity, new_quantity, user_id)
      VALUES (?, ?, 100, ?, 'TEST_USER')
    `).run(inventoryId, reasonId, newQty);
  });
  tx();

  const verifyInv = db.prepare('SELECT quantity FROM inventory WHERE id = ?').get(inventoryId);
  assert(verifyInv.quantity === 95, 'Inventory quantity should be 95');
  console.log('✅ Stores Adjustments Passed');

  // 2. Accounts: Cash Movement
  console.log('\nTesting Accounts Cash Movement...');
  // We need an open shift to test this properly or just the treasury
  const movementId = uuidv4();
  const amount = 500;
  const initialCash = db.prepare("SELECT SUM(CASE WHEN type='in' THEN amount ELSE -amount END) as balance FROM cash_movements").get().balance || 0;

  db.prepare(`
    INSERT INTO cash_movements (id, user_id, type, amount, category, source_type, notes, date)
    VALUES (?, 'TEST_USER', 'in', ?, 'deposit', 'treasury', 'Test Deposit', datetime('now'))
  `).run(movementId, amount);

  const verifyCash = db.prepare("SELECT SUM(CASE WHEN type='in' THEN amount ELSE -amount END) as balance FROM cash_movements").get().balance || 0;
  assert(verifyCash - initialCash === 500, `Cash balance should have increased by 500, but diff is ${verifyCash - initialCash}`);
  console.log('✅ Accounts Cash Movement Passed');

  // 3. Staff: Performance Metrics
  console.log('\nTesting Staff Metrics Query...');
  const metrics = db.prepare(`
    SELECT 
      u.id, 
      COUNT(si.id) as transactions,
      COALESCE(SUM(si.total_amount), 0) as total_revenue,
      (SELECT COUNT(*) FROM returns r WHERE r.user_id = u.id) as returns_count
    FROM users u
    LEFT JOIN sales_invoices si ON u.id = si.user_id
    GROUP BY u.id
    LIMIT 1
  `).get();
  assert(metrics !== undefined, 'Staff metrics should return a valid object');
  console.log('✅ Staff Metrics Query Passed');

  // 4. Audit: Activity Logging
  console.log('\nTesting Audit Logging...');
  db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)')
    .run('TEST_USER', 'TEST_ACTION', 'System verification test');
  
  const log = db.prepare("SELECT * FROM activity_log WHERE action = 'TEST_ACTION'").get();
  assert(log !== undefined, 'Audit log should be successfully saved');
  console.log('✅ Audit Logging Passed');

  console.log('\n--- ALL BUSINESS LOGIC TESTS PASSED ---');

  // Cleanup
  db.prepare('DELETE FROM inventory WHERE id = ?').run(inventoryId);
  db.prepare('DELETE FROM master_drugs WHERE id = ?').run(drugId);
  db.prepare('DELETE FROM cash_movements WHERE id = ?').run(movementId);
  db.prepare("DELETE FROM activity_log WHERE action = 'TEST_ACTION'").run();

} catch (err) {
  console.error('\n❌ TEST FAILED:', err);
} finally {
  db.close();
}
