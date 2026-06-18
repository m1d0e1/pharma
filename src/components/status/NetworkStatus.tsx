'use client';

import { useState, useEffect } from 'react';
import { Wifi, WifiOff, RefreshCw } from 'lucide-react';

export default function NetworkStatus() {
  const [isOnline, setIsOnline] = useState(true);
  const [lastChecked, setLastChecked] = useState<Date>(new Date());

  useEffect(() => {
    // Check initial status
    setIsOnline(navigator.onLine);

    // Add event listeners
    const handleOnline = () => {
      setIsOnline(true);
      setLastChecked(new Date());
    };

    const handleOffline = () => {
      setIsOnline(false);
      setLastChecked(new Date());
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Cleanup
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const checkConnection = () => {
    setIsOnline(navigator.onLine);
    setLastChecked(new Date());
  };

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white dark:bg-gray-800 shadow-sm">
      {isOnline ? (
        <Wifi className="w-4 h-4 text-green-500" />
      ) : (
        <WifiOff className="w-4 h-4 text-red-500" />
      )}
      <span className="text-sm font-medium">
        {isOnline ? 'Online' : 'Offline'}
      </span>
      <button
        onClick={checkConnection}
        className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
        title="Check connection"
      >
        <RefreshCw className="w-3 h-3 text-gray-500" />
      </button>
    </div>
  );
}
