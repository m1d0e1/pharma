import { execute } from '../src/lib/db/client';

(globalThis as any).__MOCK_SESSION__ = {
  id: '0ce19bbe-c1da-4e9b-8a4e-283dea9fba00',
  role: 'owner',
  permissions: { rep_can_view_financial: true }
};

async function test() {
  console.log("Testing raw insert using execute()...");
  try {
    const id = "test-exp-" + Date.now();
    const user_id = '0ce19bbe-c1da-4e9b-8a4e-283dea9fba00';
    
    const sql = `
      INSERT INTO expenses (id, user_id, category, amount, description, date)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    const params = [id, user_id, '15', 150.0, 'Test', new Date().toISOString()];
    
    const res = execute(sql, params);
    console.log("Success:", res);
  } catch (e) {
    console.error("Test failed:", e);
  }
}

test();
