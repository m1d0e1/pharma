import { act, renderHook } from '@testing-library/react';
import { useBarcodeScanner } from './useBarcodeScanner';

test('only the focused window handles a barcode scan', () => {
  const onScan = jest.fn();
  const hasFocus = jest.spyOn(document, 'hasFocus');
  renderHook(() => useBarcodeScanner(onScan));

  const scan = () => {
    for (const key of '123456') window.dispatchEvent(new KeyboardEvent('keydown', { key }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  };

  hasFocus.mockReturnValue(false);
  act(scan);
  expect(onScan).not.toHaveBeenCalled();

  hasFocus.mockReturnValue(true);
  act(scan);
  expect(onScan).toHaveBeenCalledWith('123456');
  hasFocus.mockRestore();
});

test('restores focused input value and invokes onScan when scanner fires into an input', () => {
  const onScan = jest.fn();
  jest.spyOn(document, 'hasFocus').mockReturnValue(true);
  renderHook(() => useBarcodeScanner(onScan));

  const input = document.createElement('input');
  input.value = 'initial text';
  document.body.appendChild(input);
  input.focus();

  act(() => {
    for (const key of '622123456789') {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });

  expect(onScan).toHaveBeenCalledWith('622123456789');
  expect(input.value).toBe('initial text');
  document.body.removeChild(input);
});

test('restores focused textarea value and blurs on scan', () => {
  const onScan = jest.fn();
  jest.spyOn(document, 'hasFocus').mockReturnValue(true);
  renderHook(() => useBarcodeScanner(onScan));

  const textarea = document.createElement('textarea');
  textarea.value = 'textarea note';
  document.body.appendChild(textarea);
  textarea.focus();

  act(() => {
    for (const key of '99887766') {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });

  expect(onScan).toHaveBeenCalledWith('99887766');
  expect(textarea.value).toBe('textarea note');
  expect(document.activeElement).not.toBe(textarea);
  document.body.removeChild(textarea);
});

test('ignores short sequence under 4 characters on Enter', () => {
  const onScan = jest.fn();
  jest.spyOn(document, 'hasFocus').mockReturnValue(true);
  renderHook(() => useBarcodeScanner(onScan));

  act(() => {
    for (const key of '123') {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });

  expect(onScan).not.toHaveBeenCalled();
});

test('handles human typing with slow intervals without triggering onScan', () => {
  const onScan = jest.fn();
  jest.spyOn(document, 'hasFocus').mockReturnValue(true);
  renderHook(() => useBarcodeScanner(onScan));

  const nowSpy = jest.spyOn(performance, 'now');
  let time = 1000;
  nowSpy.mockImplementation(() => time);

  act(() => {
    // Key 1
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
    // Wait 100ms (human pace)
    time += 100;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));
    time += 100;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true }));
    time += 100;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '4', bubbles: true }));
    time += 100;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });

  expect(onScan).not.toHaveBeenCalled();
  nowSpy.mockRestore();
});
