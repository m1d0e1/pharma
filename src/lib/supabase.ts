import { createBrowserClient } from '@supabase/ssr'

// Singleton pattern for Supabase browser client
let supabaseInstance: ReturnType<typeof createBrowserClient> | null = null

/**
 * Get or create a singleton Supabase browser client.
 * This ensures we don't create multiple instances across the application.
 */
export function getSupabaseBrowserClient() {
  if (supabaseInstance) {
    return supabaseInstance
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseAnonKey) {
    console.warn('Missing Supabase environment variables.');
    return null as any;
  }

  const isTauri = typeof window !== 'undefined' && (window as any).__TAURI__ !== undefined;

  supabaseInstance = createBrowserClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: isTauri,
      autoRefreshToken: isTauri,
      detectSessionInUrl: false
    }
  })
  return supabaseInstance
}

// For backward compatibility
// export const supabase = getSupabaseBrowserClient() // Removed to avoid throw on module load
