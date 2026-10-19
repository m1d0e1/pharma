import { createClient } from '@supabase/supabase-js';

// Singleton pattern for Supabase browser client
let supabaseInstance: ReturnType<typeof createClient> | null = null;

/**
 * Get or create a singleton Supabase browser client.
 * This ensures we don't create multiple instances across the application.
 */
export function getSupabaseBrowserClient() {
  if (supabaseInstance) {
    return supabaseInstance
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Public drug and interaction catalog is not configured.');
  }

  supabaseInstance = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  })
  return supabaseInstance
}
