const Database = require('better-sqlite3');
const path = require('path');
const dbPath = path.join(__dirname, 'src-tauri', 'pharma.db');
const db = new Database(dbPath);

console.log('--- Testing POS Batch Selection ---');

// 1. Find a drug with multiple batches or create one
let drugId = 1;
db.prepare("DELETE FROM inventory WHERE drug_id = 9999").run();
db.prepare("DELETE FROM master_drugs WHERE id = 9999").run();

db.prepare(`
  INSERT INTO master_drugs (id, trade_name, active_ingredient, large_unit, official_price)
  VALUES (9999, 'Test Batch Drug', 'Test', 'Box', 100)
`).run();

// Insert Batch A
const inv1 = db.prepare(`
  INSERT INTO inventory (drug_id, quantity, expiry_date, local_selling_price, cost_price, barcode)
  VALUES (9999, 10, '2025-01-01', 100, 80, 'TESTBATCH1')
`).run().lastInsertRowid;

// Insert Batch B
const inv2 = db.prepare(`
  INSERT INTO inventory (drug_id, quantity, expiry_date, local_selling_price, cost_price, barcode)
  VALUES (9999, 10, '2026-01-01', 100, 80, 'TESTBATCH2')
`).run().lastInsertRowid;

console.log(`Created test drug 9999 with Batch A (id: ${inv1}) and Batch B (id: ${inv2})`);

// 2. Simulate processCheckoutAction backend behavior
function processCheckout(items) {
  const saleId = 'TEST_SALE_' + Date.now();
  let totalAmount = 0;
  
  for (const item of items) {
    const deductionQty = item.quantity_sold;
    totalAmount += item.quantity_sold * item.unit_price;

    const validStock = item.inventory_id 
      ? db.prepare('SELECT COALESCE(SUM(quantity), 0) as total FROM inventory WHERE id = ?').get(item.inventory_id)
      : db.prepare("SELECT COALESCE(SUM(quantity), 0) as total FROM inventory WHERE drug_id = ? AND (expiry_date IS NULL OR expiry_date >= date('now'))").get(item.drug_id);
    
    if ((validStock?.total || 0) < deductionQty) {
      throw new Error(`Not enough quantity! requested ${deductionQty}, available: ${validStock?.total}`);
    }

    let remainingToDeduct = deductionQty;
    const batches = item.inventory_id 
      ? db.prepare('SELECT id, quantity, cost_price, expiry_date FROM inventory WHERE id = ?').all(item.inventory_id)
      : db.prepare("SELECT id, quantity, cost_price, expiry_date FROM inventory WHERE drug_id = ? AND quantity > 0 AND (expiry_date IS NULL OR expiry_date >= date('now')) ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END, expiry_date ASC").all(item.drug_id);

    for (const batch of batches) {
      if (remainingToDeduct <= 0) break;
      const deductFromThisBatch = Math.min(batch.quantity, remainingToDeduct);
      
      db.prepare('UPDATE inventory SET quantity = quantity - ? WHERE id = ?').run(deductFromThisBatch, batch.id);
      
      db.prepare(`
        INSERT INTO sales_items (invoice_id, inventory_id, drug_id, quantity_sold, unit_price, unit, is_negative, cost_price)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(saleId, batch.id, item.drug_id, deductFromThisBatch, item.unit_price, item.selected_unit, 0, batch.cost_price || 0);

      remainingToDeduct -= deductFromThisBatch;
    }
  }

  db.prepare(`
    INSERT INTO sales_invoices (id, pharmacy_id, user_id, total_amount, payment_method, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(saleId, 'local_default', 'test_user', totalAmount, 'cash', 'completed');

  return saleId;
}

try {
  // Test selling specifically from Batch B (inv2)
  console.log('\\nSelling 3 units from Batch B (inv2: 2026-01-01)');
  const saleId = processCheckout([
    {
      drug_id: 9999,
      inventory_id: inv2,
      quantity_sold: 3,
      unit_price: 100,
      selected_unit: 'large'
    }
  ]);

  console.log('Sale processed:', saleId);

  // Check inventory levels
  const b1 = db.prepare('SELECT quantity FROM inventory WHERE id = ?').get(inv1);
  const b2 = db.prepare('SELECT quantity FROM inventory WHERE id = ?').get(inv2);

  console.log(`Batch A quantity: ${b1.quantity} (Expected 10)`);
  console.log(`Batch B quantity: ${b2.quantity} (Expected 7)`);

  if (b1.quantity === 10 && b2.quantity === 7) {
    console.log('✅ TEST PASSED: Specific batch was successfully deducted.');
  } else {
    console.log('❌ TEST FAILED: Quantities are incorrect.');
  }

  // Cleanup
  db.prepare("DELETE FROM sales_items WHERE invoice_id = ?").run(saleId);
  db.prepare("DELETE FROM sales_invoices WHERE id = ?").run(saleId);
  db.prepare("DELETE FROM inventory WHERE drug_id = 9999").run();
  db.prepare("DELETE FROM master_drugs WHERE id = 9999").run();
  console.log('Cleanup done.');

} catch (e) {
  console.error('Test Error:', e.message);
}
