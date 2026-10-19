import * as XLSX from 'xlsx';
import { buildPurchasesReportWorkbook } from '@/components/reports/PurchasesReportsClient';

describe('purchase report offline Excel workbook bytes', () => {
  it('roundtrips owned invoice, proven return, and adjusted amounts as numeric XLSX cells', () => {
    const workbook = buildPurchasesReportWorkbook([{
      id: '2efd9b8e-19bf-48cc-8bdf-c9ee723d1460', invoice_number: 'QA-462', invoice_date: '2026-10-15',
      supplier_name: 'Tenant A', staff_name: 'Reporter A', payment_method: 'credit',
      gross_amount: 462.00000000000006, discount_amount: 0,
      total_amount: 462.00000000000006, returned_amount: 115.50000000000001,
      net_after_returns: 346.50000000000006,
      total_selling_amount: 600.0000000000001, status: 'completed',
    }], XLSX);
    const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    const restored = XLSX.read(bytes, { type: 'buffer' });
    const sheet = restored.Sheets.Purchases;
    const headers = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 })[0];
    const before = headers.indexOf('صافي الفاتورة قبل مرتجعات الموردين');
    const returns = headers.indexOf('مرتجعات الموردين الموثقة حتى وقت التقرير');
    const after = headers.indexOf('صافي الفاتورة بعد المرتجعات الموثقة');
    expect([before, returns, after].every(index => index >= 0)).toBe(true);
    const values = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1 })[1];
    expect(values[0]).toBe('QA-462'); // user-visible invoice number, not internal UUID
    expect([values[before], values[returns], values[after]]).toEqual([462, 115.5, 346.5]);
    expect(values[5]).toBe(462); // actual downloaded workbook failed at F2
    expect(values[7]).toBe(462); // and at H2
    expect(values[10]).toBe(600);
    expect(sheet.F2).toMatchObject({ t: 'n', v: 462 });
    expect(sheet.H2).toMatchObject({ t: 'n', v: 462 });
    expect(sheet.I2).toMatchObject({ t: 'n', v: 115.5 });
    expect(sheet.J2).toMatchObject({ t: 'n', v: 346.5 });
    for (const column of [5, 6, before, returns, after, 10]) {
      const address = XLSX.utils.encode_cell({ r: 1, c: column });
      expect(sheet[address]).toMatchObject({ t: 'n' });
      expect(sheet[address].f).toBeUndefined();
    }
    expect(JSON.stringify(restored)).not.toContain('tenant-b');
    expect(JSON.stringify(restored)).not.toContain('321.5');
  });

  it('escapes leading formula characters in all user sourced export text, including CSV conversion', () => {
    const workbook = buildPurchasesReportWorkbook([{
      id: 'owned-a', invoice_number: '=HYPERLINK("https://example.test","Open")',
      invoice_date: '\t+NOW()', supplier_name: '\n@SUM(1,2)',
      staff_name: '-4+2', payment_method: 'cash', total_amount: 20,
      returned_amount: 5, net_after_returns: 15, gross_amount: 20,
      discount_amount: 0, total_selling_amount: 25, status: '=CMD()',
    }], XLSX);
    const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const sheet = XLSX.read(bytes, { type: 'buffer' }).Sheets.Purchases;
    const values = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1 });
    expect(values[1][0]).toMatch(/^'=HYPERLINK/);
    expect(values[1][1]).toMatch(/^'\t\+NOW/);
    expect(values[1][2]).toMatch(/^'\n@SUM/);
    expect(values[1][3]).toMatch(/^'-4\+2/);
    expect(values[1][11]).toBe("'=CMD()");
    for (const [column, value] of values[1].entries()) {
      if (typeof value === 'string') {
        const address = XLSX.utils.encode_cell({ r: 1, c: column });
        expect(sheet[address].t).toBe('s');
        expect(sheet[address].f).toBeUndefined();
      }
    }
    const csv = XLSX.utils.sheet_to_csv(sheet);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'\t+NOW()");
    expect(csv).not.toContain('tenant-b');
  });

  it('rejects non-finite, unsafe, fractional-cent and missing amounts without inventing zero', () => {
    const base = {
      id: 'owned-a', invoice_number: 'P-462', total_amount: 462,
      gross_amount: 462, discount_amount: 0, returned_amount: 115.5,
      net_after_returns: 346.5, total_selling_amount: 600,
    };
    for (const invalid of [NaN, Infinity, -Infinity, 462.001, Number.MAX_SAFE_INTEGER]) {
      for (const field of ['gross_amount', 'discount_amount', 'total_amount',
        'returned_amount', 'net_after_returns', 'total_selling_amount']) {
        expect(() => buildPurchasesReportWorkbook([{ ...base, [field]: invalid }], XLSX))
          .toThrow(/Invalid purchase report export amount/);
      }
    }
    for (const missing of [null, undefined, '', '462']) {
      expect(() => buildPurchasesReportWorkbook([{ ...base, total_amount: missing }], XLSX))
        .toThrow(/Invalid purchase report export amount/);
    }
    expect(() => buildPurchasesReportWorkbook([{
      ...base, returned_amount: 5, net_after_returns: 346.5,
    }], XLSX)).toThrow(/Invalid purchase report export amount: return reconciliation/);
    const missingOptional = buildPurchasesReportWorkbook([{
      ...base, gross_amount: null, discount_amount: null, total_selling_amount: null,
      returned_amount: null, net_after_returns: null,
    }], XLSX);
    const row = XLSX.utils.sheet_to_json<any[]>(missingOptional.Sheets.Purchases, { header: 1 })[1];
    expect(row.slice(5, 11)).toEqual(['غير متاح', 'غير متاح', 462, 'غير متاح', 'غير متاح', 'غير متاح']);
  });
});
