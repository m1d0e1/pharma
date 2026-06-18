'use client';

import React, { useEffect, useState } from 'react';
import ReceiptListClient from '@/components/receipts/ReceiptListClient';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { dbSelect } from '@/lib/db/tauri';
import AccessDenied from '@/components/AccessDenied';

export default function ReceiptsPage() {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    async function loadReceipts() {
      try {
        const userObj = await getClientSession();
        if (userObj) {
          setUser(userObj);

          const isAllowed = hasUserPermissionSync(userObj, 'can_view_receipts');

          if (isAllowed) {
            setAllowed(true);
            // Query 1: Fetch invoices
            const invoicesData = await dbSelect(`
          SELECT 
            si.id,
            si.total_amount,
            si.paid_amount,
            si.payment_method,
            si.discount_amount,
            si.created_at,
            si.user_id,
            si.patient_id,
            u.full_name as staff_name,
            p.full_name as patient_name,
            p.phone as patient_phone
          FROM sales_invoices si
          LEFT JOIN users u ON si.user_id = u.id
          LEFT JOIN patients p ON si.patient_id = p.id
          ORDER BY si.created_at DESC
          LIMIT 200
        `);

        if (invoicesData.length === 0) {
          setInvoices([]);
          return;
        }

        // Query 2: Fetch all items for these invoices (batch query for performance)
        const invoiceIds = invoicesData.map(inv => `'${inv.id}'`).join(',');
        const itemsData = await dbSelect(`
          SELECT 
            si.invoice_id,
            si.quantity_sold,
            si.unit_price,
            si.drug_id,
            md.trade_name,
            md.trade_name_en
          FROM sales_items si
          LEFT JOIN master_drugs md ON si.drug_id = md.id
          WHERE si.invoice_id IN (${invoiceIds})
        `);

        // Map items to invoices
        const fullInvoices = invoicesData.map(invoice => {
          const items = itemsData.filter((item: any) => item.invoice_id === invoice.id);

          return {
            ...invoice,
            profiles: { full_name: invoice.staff_name || 'موظف' },
            patients: invoice.patient_name ? { full_name: invoice.patient_name, phone: invoice.patient_phone } : null,
            payment_method: invoice.payment_method || 'cash',
            sales_items: items.map((item: any) => ({
              quantity_sold: item.quantity_sold,
              unit_price: item.unit_price,
              trade_name: item.trade_name,
              trade_name_en: item.trade_name_en,
              inventory: {
                master_drugs: { 
                  trade_name: item.trade_name || 'صنف غير معروف',
                  trade_name_en: item.trade_name_en || ''
                }
              }
            }))
          };
        });

        setInvoices(fullInvoices);
        }
        }
      } catch (err) {
        console.error('Failed to load receipts:', err);
      } finally {
        setLoading(false);
      }
    }

    loadReceipts();
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-24" dir="rtl">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!user || !allowed) {
    return <AccessDenied />;
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700" dir="rtl">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">سجل الفواتير</h1>
          <p className="text-slate-500 mt-1">مراجعة المبيعات السابقة وتفاصيل المعاملات.</p>
        </div>
      </div>

      <ReceiptListClient initialInvoices={invoices} />
    </div>
  );
}
