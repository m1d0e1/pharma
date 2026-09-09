'use client';

import { useEffect, useRef } from 'react';

// Defines how fast keystrokes must be to be considered a scanner (in milliseconds)
// Hardware scanners typically type <30ms between keys, humans rarely <50ms
const SCANNER_TIMEOUT = 50;

function restoreInputValue(target: HTMLElement | null, initialValue: string) {
  if (!target) return;
  const isInput = target instanceof HTMLInputElement;
  const isTextArea = target instanceof HTMLTextAreaElement;
  if (!isInput && !isTextArea) return;

  const prototype = isTextArea
    ? window.HTMLTextAreaElement?.prototype
    : window.HTMLInputElement?.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (descriptor && descriptor.set) {
    descriptor.set.call(target, initialValue);
  } else {
    (target as HTMLInputElement | HTMLTextAreaElement).value = initialValue;
  }
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
  target.blur();
}

export function useBarcodeScanner(onScan: (barcode: string) => void) {
  const buffer = useRef<string>('');
  const lastKeyTime = useRef<number>(performance.now());
  const scanTargetRef = useRef<HTMLElement | null>(null);
  const scanTargetValueRef = useRef<string>('');
  const onScanRef = useRef(onScan);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!document.hasFocus()) return;

      const target = (document.activeElement || e.target) as HTMLElement | null;
      const isInput = target ? (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) : false;

      const currentTime = performance.now();
      const timeDiff = currentTime - lastKeyTime.current;

      // If too much time passed since the last key, it's a new sequence
      if (timeDiff > SCANNER_TIMEOUT) {
        buffer.current = '';
        scanTargetRef.current = null;
        scanTargetValueRef.current = '';
      }

      lastKeyTime.current = currentTime;

      // Enter key marks end of scan
      if (e.key === 'Enter') {
        if (buffer.current.length >= 4) {
          e.preventDefault();
          e.stopPropagation();
          const scanned = buffer.current.trim();
          buffer.current = '';
          const prevTarget = scanTargetRef.current;
          const prevValue = scanTargetValueRef.current;
          scanTargetRef.current = null;
          scanTargetValueRef.current = '';

          // ponytail: restore input state if scanner fired while focused
          if (prevTarget) {
            restoreInputValue(prevTarget, prevValue);
          }
          onScanRef.current(scanned);
        }
        return;
      }

      // Ignore non-character keys (e.g. Shift, Alt, Ctrl)
      if (e.key.length !== 1) return;

      if (buffer.current.length === 0) {
        // First key of a potential scan: remember target and value
        if (isInput) {
          scanTargetRef.current = target;
          scanTargetValueRef.current = (target as HTMLInputElement | HTMLTextAreaElement).value ?? '';
        }
      } else {
        // 2nd or later key coming rapidly: suppress input entry
        if (isInput) {
          e.preventDefault();
          e.stopPropagation();
        }
      }

      buffer.current += e.key;
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);
}
