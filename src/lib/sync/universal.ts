// Universal sync wrapper for hybrid environments

export async function syncFromCloud() {
  const isTauri = typeof window !== 'undefined' && (window as any).__TAURI__ !== undefined;

  if (isTauri) {
    console.log('Running cloud sync on Tauri...');
    const { syncFromCloudClient } = await import('./client');
    return syncFromCloudClient();
  } else {
    console.log('Running cloud sync via Server Action...');
    // We dynamically import the server action to avoid Webpack bundling issues in Tauri static builds
    try {
      const { syncFromCloudAction } = await import('@/app/actions/sync');
      return syncFromCloudAction();
    } catch (err) {
      console.error('Failed to import syncFromCloudAction, falling back to client-side sync:', err);
      const { syncFromCloudClient } = await import('./client');
      return syncFromCloudClient();
    }
  }
}
