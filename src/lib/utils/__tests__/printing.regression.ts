import { escapeHtml, generateReceiptHtml, generateWhatsAppMessage, printHtmlContent } from '@/lib/utils/printing';

const invoice = {
  id: 'invoice-12345678',
  created_at: '2026-08-25T10:30:00.000Z',
  total_amount: 90,
  payment_method: 'cash',
  patients: { full_name: '<script>patient</script>' },
  profiles: { full_name: 'Pharmacist & Owner' },
  sales_items: [{
    quantity_sold: 2,
    unit_price: 50,
    trade_name_en: '<b>Unsafe drug</b>',
    unit: 'large',
    units: { large: 'علبة' },
  }],
};

describe('receipt printing contracts', () => {
  it('escapes user data and calculates receipt totals without executable markup', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#039;');
    const html = generateReceiptHtml(invoice, { name: '<Pharma>', phone: '010&20', address: 'A < B' });

    expect(html).toContain('&lt;script&gt;patient&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;Unsafe drug&lt;/b&gt;');
    expect(html).not.toContain('<script>patient</script>');
    expect(html).toContain('100.00 EGP');
    expect(html).toContain('- 10.00 EGP');
    expect(html).toContain('90 EGP');
  });

  it('creates a plain-text share message with the invoice identity, lines, and total', () => {
    const message = generateWhatsAppMessage(invoice, { name: 'Pharma', phone: '0100' });
    expect(message).toContain('#invoice-');
    expect(message).toContain('(2 × 50) = 100.00');
    expect(message).toContain('*Total:* 90 EGP');
    expect(message).toContain('Contact: 0100');
  });

  it('writes to an isolated iframe and triggers its print dialog', () => {
    jest.useFakeTimers();
    const originalCreateElement = document.createElement.bind(document);
    const frameDocument = { open: jest.fn(), write: jest.fn(), close: jest.fn() };
    const frameWindow = { document: frameDocument, focus: jest.fn(), print: jest.fn() };
    const iframe = originalCreateElement('iframe');
    Object.defineProperty(iframe, 'contentWindow', { configurable: true, value: frameWindow });
    const createElement = jest.spyOn(document, 'createElement').mockImplementation((tagName: string) => (
      tagName === 'iframe' ? iframe : originalCreateElement(tagName)
    ));

    printHtmlContent('<html><body>receipt</body></html>');
    expect(frameDocument.write).toHaveBeenCalledWith('<html><body>receipt</body></html>');
    iframe.onload?.(new Event('load'));
    jest.advanceTimersByTime(200);
    expect(frameWindow.focus).toHaveBeenCalled();
    expect(frameWindow.print).toHaveBeenCalled();
    jest.advanceTimersByTime(1000);
    expect(document.body.contains(iframe)).toBe(false);

    createElement.mockRestore();
    jest.useRealTimers();
  });
});
