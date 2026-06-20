import Database from 'better-sqlite3';

const db = new Database('pharma_local.db');
db.pragma('foreign_keys = ON');

try {
    const id = "test-exp-" + Date.now();
    const user_id = '0ce19bbe-c1da-4e9b-8a4e-283dea9fba00';
    
    const stmt = db.prepare(`
      INSERT INTO expenses (id, user_id, category, amount, description, date)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    const res = stmt.run(id, user_id, '15', 150.0, 'Test', new Date().toISOString());
    console.log("Success:", res);
} catch (e) {
    console.error("Test failed:", e);
}
