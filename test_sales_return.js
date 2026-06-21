const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'pharma_local.db');
const db = new Database(dbPath);

async function runTest() {
  console.log('--- Starting Sales Return Simulation ---');

  // 1. Get an existing invoice or create one for testing
  let invoice = db.prepare('SELECT * FROM sales_invoices LIMIT 1').get();
  if (!invoice) {
    console.log('No existing sales invoices found. Creating a mock invoice...');
    
    // Create a drug
    const drugStmt = db.prepare(`INSERT INTO master_drugs (id, trade_name, large_to_medium, medium_to_small) VALUES ('test_drug_1', 'Test Drug', 10, 10)`);
    try { drugStmt.run(); } catch(e){}

    // Create inventory
    const invStmt = db.prepare(`INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, unit_price, cost_price) VALUES ('inv_1', 'pharm_1', 'test_drug_1', 100, 50, 40)`);
    try { invStmt.run(); } catch(e){}

    // Create invoice
    const invId = 'inv_' + Date.now();
    db.prepare(`INSERT INTO sales_invoices (id, total_amount, paid_amount, payment_method, status) VALUES (?, 100, 100, 'cash', 'completed')`).run(invId);
    
    // Create invoice item
    db.prepare(`INSERT INTO sales_items (invoice_id, inventory_id, drug_id, quantity_sold, unit_price, unit) VALUES (?, 'inv_1', 'test_drug_1', 2, 50, 'large')`).run(invId);

    invoice = db.prepare('SELECT * FROM sales_invoices WHERE id = ?').get(invId);
  }

  console.log('Using invoice:', invoice.id);

  // 2. Fetch items for this invoice
  const items = db.prepare('SELECT * FROM sales_items WHERE invoice_id = ?').all(invoice.id);
  console.log('Invoice items:', items);

  if (items.length === 0) {
    console.log('Invoice has no items. Test aborted.');
    return;
  }

  const testItem = items[0];

  console.log(`Will return 1 of inventory ${testItem.inventory_id} which was sold as ${testItem.unit}`);

  // We want to simulate the payload
  const payload = {
    invoice_id: invoice.id,
    shift_id: invoice.shift_id,
    refund_method: 'cash',
    reason: 'Defective',
    items: [
      {
        inventory_id: testItem.inventory_id,
        drug_name: 'Test Drug',
        quantity: 1, // return 1 unit
        unit_price: testItem.unit_price
      }
    ]
  };

  console.log('Payload:', JSON.stringify(payload, null, 2));

  // The logic in actions-client/returns.ts uses dbExecute etc.
  // We can just emulate the logic here to see if there are flaws.
  
  // Flaw 1: Validating returning quantity
  const alreadyReturned = db.prepare(`
    SELECT ri.inventory_id, SUM(ri.quantity_returned) as total
    FROM return_items ri
    JOIN returns r ON ri.return_id = r.id
    WHERE r.invoice_id = ? AND r.status = 'approved'
    GROUP BY ri.inventory_id
  `).all(invoice.id);

  console.log('Already returned:', alreadyReturned);

  const returned = alreadyReturned.find(ar => ar.inventory_id === testItem.inventory_id)?.total || 0;
  if (payload.items[0].quantity > (testItem.quantity_sold - returned)) {
    console.error('ERROR: Return quantity exceeds sold quantity');
  } else {
    console.log('Quantity validation passed.');
  }

  // 3. Emulate restock logic
  const drugInfo = db.prepare('SELECT large_to_medium, medium_to_small FROM master_drugs WHERE id = ?').get(testItem.drug_id);
  console.log('Drug info:', drugInfo);

  let restockQty = payload.items[0].quantity;
  if (testItem.unit === 'medium') {
    restockQty = restockQty / (drugInfo?.large_to_medium || 1);
  } else if (testItem.unit === 'small') {
    restockQty = restockQty / ((drugInfo?.large_to_medium || 1) * (drugInfo?.medium_to_small || 1));
  }

  console.log(`Restock quantity calculated as: ${restockQty} (Original return qty: ${payload.items[0].quantity})`);

  console.log('--- Test Complete ---');
}

runTest().catch(console.error);
