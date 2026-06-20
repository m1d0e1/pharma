'use client';

import { useEffect, useState } from 'react';
import { secureCache } from '@/lib/cache/secure_cache';

export default function AppInitializer({ children }: { children: React.ReactNode }) {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // Determine if we are in Tauri
    const isTauri = typeof window !== 'undefined' && ((window as any).__TAURI__ || (window as any).__TAURI_INTERNALS__);
    
    if (isTauri) {
      secureCache.load().then(() => {
        console.log('SecureCache loaded on client');
        setLoaded(true);
      }).catch(err => {
        console.error('Failed to load SecureCache on client', err);
        setLoaded(true); // Proceed anyway to avoid blocking the whole app
      });
    } else {
      // In web browser / Next.js Server, it loads synchronously on the server
      setLoaded(true);
    }
  }, []);

  if (!loaded) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-slate-50">
        <div className="text-center flex flex-col items-center">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
          <p className="text-slate-600 font-medium">جاري تهيئة قاعدة البيانات الآمنة...</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
