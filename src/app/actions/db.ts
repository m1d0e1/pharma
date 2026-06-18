'use server';

import { query, execute } from '@/lib/db/client';

export async function serverDbSelect(sql: string, params: any[] = []): Promise<{ success: boolean; data?: any[]; error?: string }> {
  try {
    const data = query(sql, params);
    return { success: true, data };
  } catch (error: any) {
    console.error('serverDbSelect error:', error);
    return { success: false, error: error.message || 'فشلت عملية الاستعلام من قاعدة البيانات' };
  }
}

export async function serverDbExecute(sql: string, params: any[] = []): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const result = execute(sql, params);
    return { 
      success: true, 
      data: { 
        rowsAffected: result.changes, 
        lastInsertId: Number(result.lastInsertRowid) 
      } 
    };
  } catch (error: any) {
    console.error('serverDbExecute error:', error);
    return { success: false, error: error.message || 'فشلت عملية التنفيذ في قاعدة البيانات' };
  }
}
