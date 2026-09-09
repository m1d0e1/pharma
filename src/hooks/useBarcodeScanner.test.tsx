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
