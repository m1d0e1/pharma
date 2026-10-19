/** @jest-environment jsdom */

import * as XLSX from 'xlsx/dist/xlsx.full.min.js';

describe('SheetJS browser download parity', () => {
  it('creates an actual XLSX Blob and requests download of the purchase report', () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
      { 'رقم الفاتورة': 'INV-001', 'المورد': 'مورد', 'صافي الفاتورة': 42.75 },
    ]), 'Purchases');

    const blobs: Blob[] = [];
    const createObjectURL = jest.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:sheetjs-report';
    });
    const oldCreateObjectURL = URL.createObjectURL;
    const clickedAnchors: HTMLAnchorElement[] = [];
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clickedAnchors.push(this);
    });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    jest.useFakeTimers();

    try {
      XLSX.writeFile(workbook, 'purchase-report-2026-10-11.xlsx');
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(blobs[0]).toBeInstanceOf(Blob);
      expect(blobs[0].size).toBeGreaterThan(100);
      expect(click).toHaveBeenCalledTimes(1);
      expect(clickedAnchors[0].download).toBe('purchase-report-2026-10-11.xlsx');
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
      click.mockRestore();
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: oldCreateObjectURL });
    }
  });
});
