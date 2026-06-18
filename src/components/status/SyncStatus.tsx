'use client';

import { useState, useEffect } from 'react';
import { Cloud, CloudOff, CheckCircle, AlertCircle, Clock } from 'lucide-react';

interface SyncStatus {
  isOnline: boolean;
  lastSyncAt: Date | null;
  pendingOperations: number;
  isSyncing: boolean;
}

export default function SyncStatus() {
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    isOnline: navigator.onLine,
    lastSyncAt: null,
    pendingOperations: 0,
    isSyncing: false,
  });

  useEffect(() => {
    // Load sync status from localStorage
    const loadSyncStatus = () => {
      const stored = localStorage.getItem('syncStatus');
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          setSyncStatus({
            ...parsed,
            lastSyncAt: parsed.lastSyncAt ? new Date(parsed.lastSyncAt) : null,
          });
        } catch (error) {
          console.error('Failed to parse sync status:', error);
        }
      }
    };

    loadSyncStatus();

    // Update online status
    const handleOnline = () => {
      setSyncStatus((prev) => ({ ...prev, isOnline: true }));
    };

    const handleOffline = () => {
      setSyncStatus((prev) => ({ ...prev, isOnline: false }));
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Check for sync updates periodically
    const interval = setInterval(loadSyncStatus, 5000);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearInterval(interval);
    };
  }, []);

  const formatLastSync = (date: Date | null): string => {
    if (!date) return 'Never';

    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  };

  const getStatusIcon = () => {
    if (syncStatus.isSyncing) {
      return <Clock className="w-4 h-4 text-blue-500 animate-spin" />;
    }

    if (!syncStatus.isOnline) {
      return <CloudOff className="w-4 h-4 text-gray-500" />;
    }

    if (syncStatus.pendingOperations > 0) {
      return <AlertCircle className="w-4 h-4 text-yellow-500" />;
    }

    return <CheckCircle className="w-4 h-4 text-green-500" />;
  };

  const getStatusText = () => {
    if (syncStatus.isSyncing) return 'Syncing...';
    if (!syncStatus.isOnline) return 'Offline';
    if (syncStatus.pendingOperations > 0) return `${syncStatus.pendingOperations} pending`;
    return 'Synced';
  };

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white dark:bg-gray-800 shadow-sm">
      {getStatusIcon()}
      <span className="text-sm font-medium">{getStatusText()}</span>
      {syncStatus.lastSyncAt && (
        <span className="text-xs text-gray-500">
          Last sync: {formatLastSync(syncStatus.lastSyncAt)}
        </span>
      )}
    </div>
  );
}
