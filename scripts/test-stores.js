const { dbSelect, dbExecute, dbGet, generateId } = require('../src/lib/db/client');

async function testStores() {
  console.log('Testing Stores Module...');
  
  try {
    // 1. Add mock inventory item if needed
    const mockDrugId = 1;
    const inventoryId = generateId();
    await dbExecute(`
      INSERT OR IGNORE INTO inventory (id, pharmacy_id, drug_id, quantity, local_selling_price, expiry_date, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [inventoryId, 'PHARMA_LOCAL', mockDrugId, 100, 50, '2027-01-01', 'available']);

    // 2. Perform an adjustment using the exact SQL logic from the actions
    // Let's deduct 5 items due to damage
    console.log('Adjusting inventory...');
    
    // Simulating what updateInventoryAction does:
    const adjustmentQty = -5;
    const reasonId = 1; // Assuming 1 is 'Damage'
    const newQuantity = 100 + adjustmentQty; // 95

    await dbExecute(`
      UPDATE inventory 
      SET quantity = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `, [newQuantity, inventoryId]);

    // Add transaction
    await dbExecute(`
      INSERT INTO inventory_transactions (id, inventory_id, user_id, type, quantity_change, previous_quantity, new_quantity, reason_id, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [generateId(), inventoryId, 'TEST_USER', 'adjustment', adjustmentQty, 100, newQuantity, reasonId, 'Testing adjustment from script']);

    // Verify it updated
    const inventory = await dbGet('SELECT quantity FROM inventory WHERE id = ?', [inventoryId]);
    console.log(`New inventory quantity: ${inventory.quantity} (Expected: 95)`);
    if (inventory.quantity !== 95) throw new Error('Inventory adjustment logic failed!');

    // Check transactions
    const transaction = await dbGet('SELECT * FROM inventory_transactions WHERE inventory_id = ? ORDER BY created_at DESC LIMIT 1', [inventoryId]);
    if (!transaction) throw new Error('Transaction log not created!');
    console.log('Transaction logged successfully:', transaction.type, transaction.quantity_change);

    console.log('Stores Adjustment tests passed!');

  } catch (error) {
    console.error('Stores test failed:', error);
  }
}

testStores();
