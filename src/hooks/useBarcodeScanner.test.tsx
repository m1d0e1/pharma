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
});
