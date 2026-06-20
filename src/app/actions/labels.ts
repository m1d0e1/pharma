'use server';


import { dbSelect, dbExecute, dbGet, dbTransaction } from '@/lib/db/tauri';
const logActivity = async (userId, action, details) => {
  try {
    await dbExecute('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)', [userId, action, details]);
  } catch (e) {
    console.error('Failed to log activity:', e);
  }
};
const initLocalDb = () => {};
const clearAuditLogs = async () => {
  try {
    await dbExecute('DELETE FROM activity_log');
    return true;
  } catch (e) {
    console.error('Failed to clear activity logs:', e);
    return false;
  }
};

const db = {
  prepare: (sql) => ({
    all: (...p) => {
      const args = p.length === 1 && Array.isArray(p[0]) ? p[0] : p;
      return dbSelect(sql, args);
    },
    get: (...p) => {
      const args = p.length === 1 && Array.isArray(p[0]) ? p[0] : p;
      return dbGet(sql, args);
    },
    run: async (...p) => {
      const args = p.length === 1 && Array.isArray(p[0]) ? p[0] : p;
      const res = await dbExecute(sql, args);
      return {
        changes: res.rowsAffected,
        lastInsertRowid: res.lastInsertId,
        rowsAffected: res.rowsAffected,
        lastInsertId: res.lastInsertId
      };
    }
  }),
  transaction: (cb) => {
    return (...args) => dbTransaction(async () => await cb(...args));
  },
  exec: (sql) => {
    return dbExecute(sql);
  }
};





const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;

export async function getLabelTemplatesAction() {
  try {
    const items = await db.prepare('SELECT * FROM label_templates').all();
    return { success: true, data: items };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function saveLabelTemplateAction(data: { name: string, width: number, height: number, content_json: string, is_default?: boolean }) {
  try {
    if (data.is_default) {
      await db.prepare('UPDATE label_templates SET is_default = 0').run();
    }
    
    const stmt = db.prepare(`
      INSERT INTO label_templates (name, width, height, content_json, is_default)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    await stmt.run(data.name, data.width, data.height, data.content_json, data.is_default ? 1 : 0);
    
    revalidatePath('/settings/labels');
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}
