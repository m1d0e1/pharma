export const isClient = typeof window !== 'undefined';
export const isTauri = isClient && (
  process.env.NEXT_PUBLIC_TAURI === '1' ||
  (globalThis as any).isTauri === true ||
  !!(window as any).__TAURI__ ||
  !!(window as any).__TAURI_INTERNALS__
);
