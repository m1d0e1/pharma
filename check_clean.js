const Database = require('better-sqlite3');
const db = new Database('./src-tauri/pharma_local.db');

const cleanString = (str) => {
  if (!str) return null;
  // Trim spaces and special characters at ends
  str = str.replace(/^[^a-zA-Z0-9\u0600-\u06FF]+|[^a-zA-Z0-9\u0600-\u06FF]+$/g, '');
  if (str.length <= 2) return null; // Too short
  if (/^\d+$/.test(str)) return null; // Pure numbers
  
  // Convert to Title Case
  str = str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  return str;
};

const tables = ['category', 'manufacturer', 'scientific_group'];
tables.forEach(col => {
  const rows = db.prepare(`SELECT DISTINCT ${col} as val FROM master_drugs WHERE ${col} IS NOT NULL AND ${col} != ''`).all();
  
  const cleaned = new Set();
  let dropped = 0;
  rows.forEach(row => {
    const c = cleanString(row.val);
    if (c) {
      cleaned.add(c);
    } else {
      dropped++;
    }
  });
  
  console.log(`${col}: Raw: ${rows.length}, Cleaned: ${cleaned.size}, Dropped: ${dropped}`);
});

db.close();
