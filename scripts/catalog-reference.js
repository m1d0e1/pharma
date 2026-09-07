const fs = require('fs');
const { parse } = require('csv-parse/sync');

// Keep the CSV reference separate from the legacy seed IDs and legacy-only drugs.
function loadReference(filename) {
  const records = parse(fs.readFileSync(filename, 'utf8'), { bom: true, skip_empty_lines: true, trim: true });
  const columns = ['Trade Name', 'Price', 'Active Ingredient', 'Category', 'Manufacturer'];
  if (JSON.stringify(records.shift()) !== JSON.stringify(columns) || !records.length) {
    throw new Error('Invalid or empty drug reference CSV');
  }
  return records.map(([name, price, ingredient, category, manufacturer]) => {
    if (!name || !price || !Number.isFinite(Number(price)) || Number(price) < 0) {
      throw new Error(`Invalid reference name/price: ${name}`);
    }
    return [name, Number(price), ingredient, category, manufacturer];
  });
}

function installReference(db, rows) {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS catalog_csv_reference (
      trade_name TEXT NOT NULL, official_price REAL NOT NULL,
      active_ingredient TEXT, category TEXT, manufacturer TEXT);
      DELETE FROM catalog_csv_reference;`);
    const insert = db.prepare('INSERT INTO catalog_csv_reference VALUES (?, ?, ?, ?, ?)');
    for (const row of rows) insert.run(...row);
  })();
}

module.exports = { loadReference, installReference };
