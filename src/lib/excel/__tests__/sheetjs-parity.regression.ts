/** @jest-environment node */

import * as XLSX from 'xlsx';

type DrugRow = {
  id: number;
  trade_name: string;
  trade_name_en: string;
  generic_name: string;
  active_ingredient: string;
  barcode: string;
  official_price: number;
  large_unit: string;
  medium_unit: string;
  small_unit: string;
  large_to_medium: number;
  medium_to_small: number;
  category: string;
  manufacturer: string;
  stop_dealing: number;
};

function drugRow(index: number): DrugRow {
  return {
    id: index + 1,
    trade_name: `دواء ${index + 1}`,
    trade_name_en: `Medicine ${index + 1}`,
    generic_name: `Generic ${index % 31}`,
    active_ingredient: `Ingredient ${index % 37}`,
    barcode: `00${String(100000000000 + index)}`,
    official_price: (index % 10000) / 4,
    large_unit: 'علبة',
    medium_unit: 'شريط',
    small_unit: 'قرص',
    large_to_medium: 10,
    medium_to_small: 10,
    category: `Category ${index % 19}`,
    manufacturer: `Maker ${index % 23}`,
    stop_dealing: index % 7 === 0 ? 1 : 0,
  };
}

function binaryString(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let index = 0; index < bytes.length; index += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + 8192)));
  }
  return chunks.join('');
}

function workbookBytes(sheets: Array<[string, Record<string, unknown>[]]>): Uint8Array {
  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of sheets) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), name);
  }
  const result = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  return new Uint8Array(result);
}

describe('Patched SheetJS import/export parity', () => {
  it('roundtrips master drugs with Arabic, prices, leading-zero barcodes and all 15 columns via FileReader binary strings', () => {
    const rows = [drugRow(0), drugRow(1), drugRow(199), drugRow(1005)];
    const bytes = workbookBytes([['Drugs', rows]]);
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);

    const parsed = XLSX.read(binaryString(bytes), { type: 'binary' });
    expect(parsed.SheetNames).toEqual(['Drugs']);
    expect(XLSX.utils.sheet_to_json(parsed.Sheets[parsed.SheetNames[0]])).toEqual(rows);
  });

  it('roundtrips multi-sheet inventory and master_drugs with raw numeric values and browser/Tauri binary exports', () => {
    const inventory = [
      { drug_id: 17, pharmacy_id: 'local_default', quantity: 8.5, cost_price: 10.25, barcode: '001234500' },
      { drug_id: 18, pharmacy_id: 'branch_2', quantity: 0, cost_price: 0, barcode: '000765432' },
    ];
    const drugs = [drugRow(16), drugRow(17)];
    const bytes = workbookBytes([['inventory', inventory], ['master_drugs', drugs]]);
    const nativePayload = Array.from(bytes);
    expect(nativePayload.length).toBeGreaterThan(100);
    expect(nativePayload.every(value => Number.isInteger(value) && value >= 0 && value <= 255)).toBe(true);

    const parsed = XLSX.read(binaryString(new Uint8Array(nativePayload)), { type: 'binary' });
    expect(parsed.SheetNames).toEqual(['inventory', 'master_drugs']);
    const inventorySheet = parsed.Sheets.inventory || parsed.Sheets.Inventory || parsed.Sheets[parsed.SheetNames[0]];
    const drugsSheet = parsed.Sheets.master_drugs || parsed.Sheets.Drugs;
    expect(XLSX.utils.sheet_to_json(inventorySheet, { raw: true })).toEqual(inventory);
    expect(XLSX.utils.sheet_to_json(drugsSheet, { raw: true })).toEqual(drugs);
  });

  it('reads legacy BIFF8 .xls through the existing FileReader binary-string path', () => {
    const workbook = XLSX.utils.book_new();
    const rows = [drugRow(0), drugRow(9)];
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Drugs');
    const xls = XLSX.write(workbook, { bookType: 'biff8', type: 'binary' });
    expect(xls.charCodeAt(0)).toBe(0xd0);
    expect(xls.charCodeAt(1)).toBe(0xcf);

    const parsed = XLSX.read(xls, { type: 'binary' });
    expect(parsed.SheetNames).toEqual(['Drugs']);
    expect(XLSX.utils.sheet_to_json(parsed.Sheets.Drugs, { raw: true })).toEqual(rows);
  });

  it('does not pollute Object.prototype when importing workbook headers named __proto__ and constructor', () => {
    const injectedProperty = 'sheetjsPollutedByWorkbook';
    const originalPrototypeDescriptors = Object.getOwnPropertyDescriptors(Object.prototype);
    expect(Object.prototype).not.toHaveProperty(injectedProperty);

    // Exercise the actual XLSX binary reader and the default inventory/catalog JSON conversion.
    const worksheet = XLSX.utils.aoa_to_sheet([
      ['__proto__', 'constructor', 'prototype', 'id'],
      ['{"sheetjsPollutedByWorkbook":true}', '{"prototype":{"sheetjsPollutedByWorkbook":true}}', 'attacker-controlled', 42],
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Drugs');
    const binary = XLSX.write(workbook, { bookType: 'xlsx', type: 'binary' });

    const parsed = XLSX.read(binary, { type: 'binary' });
    expect(XLSX.utils.sheet_to_json(parsed.Sheets.Drugs, { header: 1 })[0]).toEqual([
      '__proto__', 'constructor', 'prototype', 'id',
    ]);
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(parsed.Sheets.Drugs);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(42);
    expect(Object.getPrototypeOf(rows[0])).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(originalPrototypeDescriptors);
    expect(Object.prototype).not.toHaveProperty(injectedProperty);
    expect(({} as Record<string, unknown>)[injectedProperty]).toBeUndefined();
  });

  it('exposes the browser download API used for purchase-report export', () => {
    expect(typeof XLSX.writeFile).toBe('function');
    const report = workbookBytes([['Purchases', [
      { 'رقم الفاتورة': 'INV-001', 'المورد': 'مورد', 'صافي الفاتورة': 125.5 },
    ]]]);
    const parsed = XLSX.read(report, { type: 'array' });
    expect(XLSX.utils.sheet_to_json(parsed.Sheets.Purchases)).toEqual([
      { 'رقم الفاتورة': 'INV-001', 'المورد': 'مورد', 'صافي الفاتورة': 125.5 },
    ]);
  });

  const catalogStress = process.env.RUN_EXCEL_STRESS === '1' ? it : it.skip;
  catalogStress('roundtrips 191,000 catalog items with all 15 export columns', () => {
    const rows = Array.from({ length: 191000 }, (_, index) => drugRow(index));
    const bytes = workbookBytes([['Drugs', rows]]);
    const parsed = XLSX.read(bytes, { type: 'array' });
    const imported = XLSX.utils.sheet_to_json<DrugRow>(parsed.Sheets.Drugs);
    const fields: Array<keyof DrugRow> = [
      'id', 'trade_name', 'trade_name_en', 'generic_name', 'active_ingredient',
      'barcode', 'official_price', 'large_unit', 'medium_unit', 'small_unit',
      'large_to_medium', 'medium_to_small', 'category', 'manufacturer', 'stop_dealing',
    ];

    expect(imported).toHaveLength(rows.length);
    for (let index = 0; index < rows.length; index++) {
      const actual = imported[index];
      const expected = rows[index];
      if (Object.keys(actual).length !== fields.length) {
        throw new Error(`Catalog row ${index} changed its column count`);
      }
      for (const field of fields) {
        if (actual[field] !== expected[field]) {
          throw new Error(`Catalog cell ${index + 1}:${field} changed on XLSX roundtrip`);
        }
      }
    }
  }, 240000);
});
