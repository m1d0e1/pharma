'use server';

// Client-side stub to satisfy Webpack static resolution during Tauri build.
// These actions are not executed in the Tauri app, which uses direct SQLite IPC.

export async function serverDbSelect(sql: string, params: any[] = []): Promise<{ success: boolean; data?: any[]; error?: string }> {
  return { success: false, error: 'Database server action not supported in Tauri client.' };
}

export async function serverDbExecute(sql: string, params: any[] = []): Promise<{ success: boolean; data?: any; error?: string }> {
  return { success: false, error: 'Database server action not supported in Tauri client.' };
}
