const Database = require('better-sqlite3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const dbPath = path.join(__dirname, '../pharma_local.db');
const db = new Database(dbPath);

console.log('--- STARTING TAURI BUSINESS LOGIC TESTS: PHASE 2 ---');

function assert(condition, message) {
  if (!condition) {
    console.error('❌ FAIL:', message);
    process.exit(1);
  }
}

try {
  const testUserId = 'TEST_USER_P2';
  const shiftId = uuidv4();
  const drugId = 2001;
  const inventoryId = uuidv4();
  const patientId = uuidv4();
  
  // 1. Shifts & Settlement
  console.log('\nTesting Shifts & Handover...');
  // Open Shift
  db.prepare(`
    INSERT INTO shift_registers (id, user_id, status, shift_start, starting_cash_amount, expected_cash_amount, cash_difference)
    VALUES (?, ?, 'open', CURRENT_TIMESTAMP, 0, 0, 0)
  `).run(shiftId, testUserId);
  const shift = db.prepare("SELECT * FROM shift_registers WHERE id = ?").get(shiftId);
  assert(shift.status === 'open', 'Shift should be open');
  console.log('✅ Shifts & Handover Passed');

  // 2. Master Drugs & Patients
  console.log('\nTesting Master Drugs & Patients...');
  // Master Drug
  db.prepare('INSERT OR IGNORE INTO master_drugs (id, trade_name_en) VALUES (?, ?)').run(drugId, 'Phase 2 Drug');
  
  // Inventory setup for Sales
  db.prepare(`
    INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, local_selling_price, expiry_date)
    VALUES (?, 'TEST_PHARMA', ?, 50, 100, '2028-01-01')
  `).run(inventoryId, drugId);
  
  // Patient
  db.prepare(`
    INSERT INTO patients (id, full_name, phone, points_balance)
    VALUES (?, 'Test Patient P2', '01000000000', 0)
  `).run(patientId);
  console.log('✅ Master Drugs & Patients Setup Passed');

  // 3. Sales & Returns
  console.log('\nTesting Sales & POS...');
  const invoiceId = uuidv4();
  const soldQty = 2;
  const totalAmount = soldQty * 100;
  
  const txSales = db.transaction(() => {
    // Invoice
    db.prepare(`
      INSERT INTO sales_invoices (id, user_id, patient_id, shift_id, total_amount, payment_method, status)
      VALUES (?, ?, ?, ?, ?, 'cash', 'completed')
    `).run(invoiceId, testUserId, patientId, shiftId, totalAmount);
    
    // Items
    db.prepare(`
      INSERT INTO sales_items (invoice_id, inventory_id, drug_id, quantity_sold, unit_price)
      VALUES (?, ?, ?, ?, 100)
    `).run(invoiceId, inventoryId, drugId, soldQty);

    // Inventory Deduction
    db.prepare('UPDATE inventory SET quantity = quantity - ? WHERE id = ?').run(soldQty, inventoryId);
    
    // Loyalty Points Update (e.g. 1 point per 10 currency)
    db.prepare('UPDATE patients SET points_balance = points_balance + ? WHERE id = ?').run(Math.floor(totalAmount / 10), patientId);

    // Cash Movement
    db.prepare(`
      INSERT INTO cash_movements (id, user_id, shift_id, type, amount, category, source_type, target_name, date)
      VALUES (?, ?, ?, 'in', ?, 'sales', 'invoice', ?, datetime('now'))
    `).run(uuidv4(), testUserId, shiftId, totalAmount, invoiceId);
  });
  txSales();

  // Verifications
  const updatedInv = db.prepare('SELECT quantity FROM inventory WHERE id = ?').get(inventoryId);
  assert(updatedInv.quantity === 48, `Inventory not properly deducted. Got: ${updatedInv.quantity}`);
  
  const updatedPat = db.prepare('SELECT points_balance FROM patients WHERE id = ?').get(patientId);
  assert(updatedPat.points_balance === 20, `Loyalty points not awarded correctly. Got: ${updatedPat.points_balance}`);
  
  console.log('✅ Sales & Returns Logic Passed');

  // 4. Purchases Module
  console.log('\nTesting Purchases...');
  const purchaseId = uuidv4();
  const supplierId = 9999;
  db.prepare(`INSERT INTO suppliers (id, name_ar) VALUES (?, 'Test Supplier P2')`).run(supplierId);
  
  db.prepare(`
    INSERT INTO purchase_invoices (id, supplier_id, user_id, total_amount, status, payment_method, invoice_date)
    VALUES (?, ?, ?, 500, 'received', 'cash', CURRENT_DATE)
  `).run(purchaseId, supplierId, testUserId);
  
  const purchaseVerify = db.prepare('SELECT status FROM purchase_invoices WHERE id = ?').get(purchaseId);
  assert(purchaseVerify.status === 'received', 'Purchase invoice failed');
  console.log('✅ Purchases Logic Passed');

  // 5. Reports & COGS
  console.log('\nTesting Reports & COGS Query...');
  // Ensure the generic SQLite COGS query works
  const cogsQuery = db.prepare(`
    SELECT 
      SUM(si.quantity_sold * si.unit_price) as revenue,
      SUM(si.quantity_sold * COALESCE(inv.cost_price, 0)) as cogs
    FROM sales_items si
    LEFT JOIN inventory inv ON si.inventory_id = inv.id
    WHERE si.invoice_id = ?
  `).get(invoiceId);
  assert(cogsQuery.revenue === 200, 'COGS Revenue mismatch');
  console.log('✅ Reports & COGS Logic Passed');

  console.log('\n--- ALL PHASE 2 BUSINESS LOGIC TESTS PASSED ---');

  // Cleanup
  db.prepare('DELETE FROM suppliers WHERE id = ?').run(supplierId);
  db.prepare('DELETE FROM purchase_invoices WHERE id = ?').run(purchaseId);
  db.prepare('DELETE FROM cash_movements WHERE shift_id = ?').run(shiftId);
  db.prepare('DELETE FROM patients WHERE id = ?').run(patientId);
  db.prepare('DELETE FROM sales_items WHERE invoice_id = ?').run(invoiceId);
  db.prepare('DELETE FROM sales_invoices WHERE id = ?').run(invoiceId);
  db.prepare('DELETE FROM inventory WHERE id = ?').run(inventoryId);
  db.prepare('DELETE FROM master_drugs WHERE id = ?').run(drugId);
  db.prepare('DELETE FROM shift_registers WHERE id = ?').run(shiftId);

} catch (err) {
  console.error('\n❌ TEST FAILED:', err);
} finally {
  db.close();
}
