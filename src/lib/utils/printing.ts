export const escapeHtml = (str: string): string => {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

export const generateReceiptHtml = (invoice: any, pharmacyInfo: any) => {
  const safeInvoiceId = escapeHtml(invoice.id.substring(0, 8).toUpperCase())
  const safePatientName = invoice.patients?.full_name
    ? escapeHtml(invoice.patients.full_name)
    : 'Walk-in Customer'
  const safeProfileName = escapeHtml(invoice.profiles?.full_name || 'System')
  const safeDate = escapeHtml(new Date(invoice.created_at).toLocaleString('en-US'))
  const safeTotalAmount = escapeHtml(invoice.total_amount.toLocaleString())
  
  const safePharmacyName = escapeHtml(pharmacyInfo.name)
  const safePharmacyPhone = escapeHtml(pharmacyInfo.phone)
  const safePharmacyAddress = escapeHtml(pharmacyInfo.address)

  const subtotal = invoice.sales_items?.reduce((s: number, item: any) => s + (item.quantity_sold * item.unit_price), 0) || 0;
  const discount = Math.max(0, subtotal - invoice.total_amount);

  const paymentLabels: Record<string, string> = {
    cash: '💵 Cash', 
    credit: '💳 Credit', 
    check: '📝 Check', 
    visa: '🏦 Card', 
    delivery: '🛵 Delivery'
  };
  const paymentLabel = paymentLabels[invoice.payment_method] || 'Cash';

  const itemsHtml = invoice.sales_items?.map((item: any) => {
    const safeTradeName = escapeHtml(item.inventory?.master_drugs?.trade_name_en || item.trade_name_en || item.inventory?.master_drugs?.trade_name || item.trade_name || 'Drug Item')
    const safeQuantity = escapeHtml(item.quantity_sold.toString())
    const safeUnitPrice = escapeHtml(item.unit_price.toFixed(2))
    const safeTotal = escapeHtml((item.quantity_sold * item.unit_price).toFixed(2))
    
    return `
      <tr>
        <td style="padding: 8px 4px; border-bottom: 1px dashed #ddd; font-size: 12px; font-weight: bold;">${safeTradeName}</td>
        <td style="padding: 8px 4px; border-bottom: 1px dashed #ddd; text-align: center; font-size: 12px;">${safeQuantity}</td>
        <td style="padding: 8px 4px; border-bottom: 1px dashed #ddd; text-align: left; font-size: 12px;">${safeUnitPrice}</td>
        <td style="padding: 8px 4px; border-bottom: 1px dashed #ddd; text-align: left; font-weight: 900; font-size: 12px;">${safeTotal}</td>
      </tr>
    `
  }).join('') || '<tr><td colspan="4" style="text-align:center; padding: 20px;">No items</td></tr>';

  return `
    <html dir="ltr">
      <head>
        <title>Receipt #${safeInvoiceId}</title>
        <style>
          @page { size: 80mm auto; margin: 0; }
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            padding: 10mm 4mm; 
            color: #000; 
            width: 80mm; 
            margin: 0 auto; 
            font-size: 12px; 
            line-height: 1.5;
          }
          .header { text-align: center; padding-bottom: 12px; border-bottom: 3px double #000; margin-bottom: 12px; }
          .pharmacy-name { font-size: 24px; font-weight: 900; margin: 0 0 4px 0; letter-spacing: -1px; }
          .pharmacy-info { font-size: 10px; font-weight: bold; }
          
          .section-title { font-size: 10px; font-weight: 900; text-transform: uppercase; border-bottom: 1px solid #000; margin: 12px 0 6px 0; padding-bottom: 2px; }
          
          .meta { display: flex; justify-content: space-between; margin-bottom: 4px; }
          .meta-label { font-weight: 900; min-width: 80px; font-size: 10px; color: #444; }
          .meta-value { font-weight: bold; font-size: 11px; }

          table { width: 100%; border-collapse: collapse; margin: 12px 0; }
          th { border-bottom: 1px solid #000; padding: 6px 4px; text-align: left; font-size: 10px; font-weight: 900; }
          
          .totals { margin-top: 12px; padding-top: 8px; border-top: 2px solid #000; }
          .total-row { display: flex; justify-content: space-between; margin-bottom: 4px; }
          .total-row.grand { font-size: 22px; font-weight: 900; margin-top: 8px; padding-top: 8px; border-top: 1px dashed #000; }
          
          .payment-method { text-align: center; margin-top: 12px; }
          .payment-badge { border: 2px solid #000; padding: 4px 16px; font-size: 14px; font-weight: 900; display: inline-block; }

          .footer { margin-top: 24px; text-align: center; font-size: 10px; border-top: 1px solid #eee; padding-top: 12px; }
          .disclaimer { font-size: 9px; font-style: italic; color: #666; margin-top: 12px; }
          
          @media print { body { width: 80mm; } }
        </style>
      </head>
      <body>
        <div class="header">
          <p class="pharmacy-name">${safePharmacyName}</p>
          <p class="pharmacy-info">${safePharmacyAddress}</p>
          <p class="pharmacy-info">Tel: ${safePharmacyPhone}</p>
        </div>

        <div class="section-title">Invoice Details</div>
        <div class="meta">
          <span class="meta-label">Invoice No:</span>
          <span class="meta-value">#${safeInvoiceId}</span>
        </div>
        <div class="meta">
          <span class="meta-label">Date:</span>
          <span class="meta-value">${safeDate}</span>
        </div>
        <div class="meta">
          <span class="meta-label">Customer:</span>
          <span class="meta-value">${safePatientName}</span>
        </div>
        <div class="meta">
          <span class="meta-label">Pharmacist:</span>
          <span class="meta-value">${safeProfileName}</span>
        </div>

        <table>
          <thead>
            <tr>
              <th style="width: 50%;">Item</th>
              <th style="text-align: center;">Qty</th>
              <th style="text-align: left;">Price</th>
              <th style="text-align: left;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHtml}
          </tbody>
        </table>

        <div class="totals">
          <div class="total-row">
            <span style="font-weight: bold;">Subtotal:</span>
            <span>${subtotal.toFixed(2)} EGP</span>
          </div>
          ${discount > 0 ? `
          <div class="total-row">
            <span style="font-weight: bold;">Total Discount:</span>
            <span>- ${discount.toFixed(2)} EGP</span>
          </div>
          ` : ''}
          <div class="total-row grand">
            <span>Total:</span>
            <span>${safeTotalAmount} EGP</span>
          </div>
        </div>

        <div class="payment-method">
           <div class="payment-badge">${paymentLabel}</div>
        </div>

        <div class="footer">
          <p style="font-weight: 900; font-size: 14px;">Thank you for your visit!</p>
          <p>We wish you a speedy recovery</p>
          <div class="disclaimer">
            * No returns without original invoice<br>
            * Returns allowed within 14 days of purchase<br>
            * Refrigerated drugs and milk products cannot be returned
          </div>
          <p style="margin-top: 12px; font-weight: bold;">--- Powered by PharmaTech ---</p>
        </div>
        
      </body>
    </html>
  `;
};

export const printHtmlContent = (html: string) => {
  const iframe = document.createElement('iframe');
  iframe.style.position = 'absolute';
  iframe.style.width = '0px';
  iframe.style.height = '0px';
  iframe.style.border = 'none';
  document.body.appendChild(iframe);
  
  const doc = iframe.contentWindow?.document || iframe.contentDocument;
  if (!doc) return;
  
  doc.open();
  doc.write(html);
  doc.close();
  
  iframe.onload = () => {
    setTimeout(() => {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
      setTimeout(() => {
        if (document.body.contains(iframe)) {
          document.body.removeChild(iframe);
        }
      }, 1000);
    }, 200);
  };
};

export const generateWhatsAppMessage = (invoice: any, pharmacyInfo: any) => {
  const itemsText = invoice.sales_items.map((item: any) => 
    `* ${item.inventory?.master_drugs?.trade_name_en || item.trade_name_en || item.inventory?.master_drugs?.trade_name || item.trade_name} (${item.quantity_sold} × ${item.unit_price}) = ${(item.quantity_sold * item.unit_price).toFixed(2)}`
  ).join('\n');

  return `
*Invoice from ${pharmacyInfo.name}*
--------------------------
*Invoice No:* #${invoice.id.substring(0, 8)}
*Date:* ${new Date(invoice.created_at).toLocaleString('en-US')}
--------------------------
*Items:*
${itemsText}
--------------------------
*Total:* ${invoice.total_amount.toLocaleString()} EGP
--------------------------
Thank you for your trust!
${pharmacyInfo.phone ? `Contact: ${pharmacyInfo.phone}` : ''}
  `.trim();
};
