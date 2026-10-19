-- Forward-only replacement of 054 receipt INSERT guard; never alters historical
-- financial source rows, receipt identities, or an earlier migration.
-- Only 041/048 sealed credit returns can reduce the payable; no inferred adoption.
DROP TRIGGER IF EXISTS native_supplier_payment_insert_guard;
CREATE TRIGGER native_supplier_payment_insert_guard BEFORE INSERT ON native_supplier_payment_receipts
BEGIN
  SELECT RAISE(ABORT,'Supplier payment lacks unambiguous receipted credit invoice')
  WHERE NOT EXISTS (
    SELECT 1 FROM purchase_invoices p
    JOIN native_purchase_create_requests c ON c.invoice_id=p.id
    JOIN native_purchase_posting_events e ON e.journal_id=c.initial_journal_id
    JOIN users u ON CAST(u.id AS TEXT)=NEW.actor_id
    JOIN suppliers s ON s.id=p.supplier_id
    WHERE p.id=NEW.invoice_id AND p.supplier_id=NEW.supplier_id
      AND p.pharmacy_id=NEW.pharmacy_id AND p.status='completed'
      AND p.payment_method='credit' AND c.source_status='completed'
      AND c.pharmacy_id=NEW.pharmacy_id AND c.supplier_id=NEW.supplier_id
      AND e.invoice_id=p.id AND e.event_kind='initial'
      AND e.pharmacy_id=NEW.pharmacy_id AND e.supplier_id=NEW.supplier_id
      AND e.payment_method='credit'
      AND c.source_total_cents=e.new_total_cents
      AND typeof(p.total_amount) IN ('integer','real')
      AND abs(p.total_amount*100- e.new_total_cents)<0.0001
      AND u.pharmacy_id=NEW.pharmacy_id AND COALESCE(u.is_active,1)=1
      AND typeof(s.balance) IN ('integer','real')
      AND abs(s.balance*100-NEW.balance_before_cents)<0.0001
      AND (SELECT count(*) FROM purchase_invoices pi WHERE pi.supplier_id=NEW.supplier_id)=1
      AND (SELECT count(*) FROM native_purchase_posting_events pe WHERE pe.invoice_id=p.id)=1
      AND (SELECT count(*) FROM native_supplier_payment_receipts prior WHERE prior.supplier_id=NEW.supplier_id
          AND prior.invoice_id=NEW.invoice_id AND prior.pharmacy_id=NEW.pharmacy_id)
          =(SELECT count(*) FROM native_supplier_payment_receipts prior WHERE prior.supplier_id=NEW.supplier_id)
      AND e.new_total_cents-
          COALESCE((SELECT sum(prior.amount_cents) FROM native_supplier_payment_receipts prior
                    WHERE prior.supplier_id=NEW.supplier_id),0)-
          COALESCE((SELECT sum(pr.amount_cents) FROM native_purchase_return_provenance pr
                    WHERE pr.supplier_id=NEW.supplier_id
                      AND pr.purchase_invoice_id=NEW.invoice_id
                      AND pr.pharmacy_id=NEW.pharmacy_id
                      AND pr.refund_method='credit'),0)=NEW.balance_before_cents
  );
  SELECT RAISE(ABORT,'Supplier purchase return lacks immutable tenant-bound credit provenance')
  WHERE EXISTS (
    SELECT 1 FROM purchase_returns pr
    LEFT JOIN native_purchase_return_provenance rp ON rp.return_id=pr.id
    WHERE pr.supplier_id=NEW.supplier_id AND (
      rp.return_id IS NULL OR rp.supplier_id<>pr.supplier_id
      OR rp.purchase_invoice_id<>NEW.invoice_id
      OR pr.purchase_invoice_id<>NEW.invoice_id OR rp.pharmacy_id<>NEW.pharmacy_id
      OR pr.refund_method<>'credit' OR rp.refund_method<>'credit'
      OR lower(trim(pr.status))<>'completed'
      OR CAST(pr.user_id AS TEXT)<>rp.actor_id
      OR typeof(pr.total_amount) NOT IN ('integer','real')
      OR abs(pr.total_amount*100-rp.amount_cents)>0.0001
      OR rp.amount_cents<=0 OR rp.line_count<1
      OR (SELECT count(*) FROM purchase_return_items ri
          WHERE ri.purchase_return_id=pr.id)<>rp.line_count
      OR (SELECT count(*) FROM native_purchase_return_line_provenance l
          WHERE l.return_id=pr.id)<>rp.line_count
      OR abs(COALESCE((SELECT sum(l.refund_value) FROM native_purchase_return_line_provenance l
          WHERE l.return_id=pr.id),0)*100-rp.amount_cents)>0.0001
      OR EXISTS(SELECT 1 FROM native_purchase_return_line_provenance l
          LEFT JOIN purchase_return_items ri ON ri.id=l.return_item_id
          LEFT JOIN purchase_invoice_items pi ON pi.id=l.purchase_invoice_item_id
          LEFT JOIN inventory i ON i.id=l.inventory_id
          WHERE l.return_id=pr.id AND (
            ri.id IS NULL OR pi.id IS NULL OR i.id IS NULL
            OR ri.purchase_return_id IS NOT pr.id
            OR ri.purchase_invoice_item_id IS NOT l.purchase_invoice_item_id
            OR ri.inventory_id IS NOT l.inventory_id
            OR pi.invoice_id IS NOT rp.purchase_invoice_id
            OR pi.inventory_id IS NOT l.inventory_id
            OR i.pharmacy_id IS NOT rp.pharmacy_id
            OR i.drug_id IS NOT pi.drug_id
            OR ri.drug_id IS NOT pi.drug_id
            OR typeof(pi.cost_price) NOT IN ('integer','real')
            OR pi.cost_price<0
            OR typeof(i.cost_price) NOT IN ('integer','real')
            OR i.cost_price<0
            OR typeof(ri.quantity_returned) NOT IN ('integer','real')
            OR abs(ri.quantity_returned-l.quantity_returned)>0.000000001
            OR typeof(ri.total_price) NOT IN ('integer','real')
            OR abs(ri.total_price-l.refund_value)>0.0001))
      OR NOT EXISTS(SELECT 1 FROM daily_journals j
          WHERE j.id=rp.journal_id AND j.pharmacy_id=rp.pharmacy_id
            AND CAST(j.created_by AS TEXT)=rp.actor_id
            AND typeof(j.total_amount) IN ('real','integer')
            AND abs(j.total_amount*100-rp.amount_cents)<0.0001)
      OR (SELECT count(*) FROM journal_entries je WHERE je.journal_id=rp.journal_id)<>2
      OR (SELECT count(*) FROM journal_entries je JOIN accounts a ON a.id=je.account_id
          WHERE je.journal_id=rp.journal_id AND je.type='debit' AND a.code='2.1'
            AND COALESCE(a.is_group,0)=0
            AND abs(je.amount*100-rp.amount_cents)<0.0001)<>1
      OR (SELECT count(*) FROM journal_entries je JOIN accounts a ON a.id=je.account_id
          WHERE je.journal_id=rp.journal_id AND je.type='credit' AND a.code='1.1.3'
            AND COALESCE(a.is_group,0)=0
            AND abs(je.amount*100-rp.amount_cents)<0.0001)<>1
      OR (SELECT count(*) FROM supplier_transactions st
          WHERE st.reference_id=pr.id AND st.supplier_id=pr.supplier_id
            AND st.type='return' AND typeof(st.amount) IN ('integer','real')
            AND abs(st.amount*100-rp.amount_cents)<0.0001)<>1
      OR (SELECT count(*) FROM supplier_transactions st
          WHERE st.reference_id=pr.id)<>1
      OR EXISTS(SELECT 1 FROM cash_movements cm
          WHERE cm.source_type='purchase_return' AND cm.target_name=pr.id)
    )
  ) OR (SELECT count(*) FROM purchase_returns pr WHERE pr.supplier_id=NEW.supplier_id)
        <>(SELECT count(*) FROM native_purchase_return_provenance rp
           WHERE rp.supplier_id=NEW.supplier_id
             AND rp.purchase_invoice_id=NEW.invoice_id
             AND rp.pharmacy_id=NEW.pharmacy_id AND rp.refund_method='credit');
  SELECT RAISE(ABORT,'Supplier payment ledger is ambiguous or mismatched') WHERE
    (SELECT count(*) FROM supplier_transactions st WHERE st.supplier_id=NEW.supplier_id)
       <>2+(SELECT count(*) FROM native_supplier_payment_receipts prior WHERE prior.supplier_id=NEW.supplier_id)
           +(SELECT count(*) FROM native_purchase_return_provenance pr
             WHERE pr.supplier_id=NEW.supplier_id AND pr.purchase_invoice_id=NEW.invoice_id
               AND pr.pharmacy_id=NEW.pharmacy_id AND pr.refund_method='credit')
    OR (SELECT count(*) FROM supplier_transactions st
        WHERE st.supplier_id=NEW.supplier_id AND st.reference_id=NEW.invoice_id AND st.type='invoice'
          AND typeof(st.amount) IN ('real','integer')
          AND abs(st.amount*100-(SELECT c.source_total_cents FROM native_purchase_create_requests c
                                  WHERE c.invoice_id=NEW.invoice_id))<0.0001)<>1
    OR NOT EXISTS(SELECT 1 FROM supplier_transactions st
      WHERE st.id=NEW.supplier_transaction_id AND st.supplier_id=NEW.supplier_id
        AND st.type='payment' AND st.payment_method=NEW.payment_method
        AND st.reference_id='supplier-payment:'||NEW.id AND st.user_id=NEW.actor_id
        AND st.date=NEW.payment_date AND typeof(st.amount) IN ('integer','real')
        AND abs(st.amount*100-NEW.amount_cents)<0.0001);
  SELECT RAISE(ABORT,'Supplier payment journal mismatched')
  WHERE NOT EXISTS (
    SELECT 1 FROM daily_journals j JOIN journal_entries e ON e.journal_id=j.id
      JOIN accounts a ON a.id=e.account_id
    WHERE j.id=NEW.journal_id AND j.pharmacy_id=NEW.pharmacy_id
      AND CAST(j.created_by AS TEXT)=NEW.actor_id AND j.date=NEW.payment_date
      AND typeof(j.total_amount) IN ('real','integer')
      AND abs(j.total_amount*100-NEW.amount_cents)<0.0001
    GROUP BY j.id HAVING count(*)=2
      AND sum(CASE WHEN e.type='debit' AND a.code='2.1' AND COALESCE(a.is_group,0)=0
                       AND typeof(e.amount) IN ('real','integer')
                       AND abs(e.amount*100-NEW.amount_cents)<0.0001 THEN 1 ELSE 0 END)=1
      AND sum(CASE WHEN e.type='credit' AND a.code=CASE WHEN NEW.payment_method='cash' THEN '1.1.1' ELSE '1.1.4' END
                       AND COALESCE(a.is_group,0)=0 AND typeof(e.amount) IN ('real','integer')
                       AND abs(e.amount*100-NEW.amount_cents)<0.0001 THEN 1 ELSE 0 END)=1
  );
  SELECT RAISE(ABORT,'Supplier payment cash movement mismatched') WHERE
    (NEW.payment_method='bank' AND EXISTS(SELECT 1 FROM cash_movements cm
                                      WHERE cm.source_type='supplier_payment' AND cm.target_name=NEW.id))
    OR (NEW.payment_method='cash' AND NOT EXISTS (
      SELECT 1 FROM cash_movements cm JOIN shifts sh ON sh.id=cm.shift_id
      WHERE cm.id=NEW.cash_movement_id AND cm.source_type='supplier_payment' AND cm.target_name=NEW.id
        AND cm.type='disbursement' AND cm.category='accounts_payable'
        AND cm.pharmacy_id=NEW.pharmacy_id AND sh.pharmacy_id=NEW.pharmacy_id
        AND lower(trim(sh.status))='open' AND CAST(cm.user_id AS TEXT)=NEW.actor_id
        AND cm.date=NEW.payment_date AND typeof(cm.amount) IN ('real','integer')
        AND abs(cm.amount*100-NEW.amount_cents)<0.0001
    )) OR (SELECT count(*) FROM cash_movements cm
            WHERE cm.source_type='supplier_payment' AND cm.target_name=NEW.id)
           <>CASE WHEN NEW.payment_method='cash' THEN 1 ELSE 0 END;
END;
