'use client';

import { useEffect, useRef } from 'react';

// Defines how fast keystrokes must be to be considered a scanner (in milliseconds)
// Hardware scanners typically type <30ms between keys, humans rarely <50ms
const SCANNER_TIMEOUT = 30;

export function useBarcodeScanner(onScan: (barcode: string) => void) {
  const buffer = useRef<string>('');
  const lastKeyTime = useRef<number>(performance.now());

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' ||
                     target.tagName === 'TEXTAREA' ||
                     target.isContentEditable;

      if (isInput) {
        // If focused on an input, we ignore the keystroke and let the browser handle it natively.
        // This prevents "double-entry chaos" as requested.
        return;
      }

      const currentTime = performance.now();

      // If too much time passed since the last key, it's a human typing. Reset the buffer.
      if (currentTime - lastKeyTime.current > SCANNER_TIMEOUT) {
        buffer.current = '';
      }

      // Update the timestamp for this keypress
      lastKeyTime.current = currentTime;

      // If the scanner hits Enter, process the buffer
      if (e.key === 'Enter') {
        if (buffer.current.length > 5) {
          e.preventDefault();
          onScan(buffer.current.trim());
          buffer.current = '';
        }
        return;
      }

      // Ignore modifier keys
      if (e.key.length === 1) {
        buffer.current += e.key;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onScan]);
}
