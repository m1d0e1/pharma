# Menu Architecture Report — Pharmacy Local Enforcer

**Version:** 0.2.14 | **Last Updated:** 2026-06-23

---

## 1. System Overview

The application has three parallel menu systems:

| Layer | Technology | File | Scope |
|-------|-----------|------|-------|
| **Native Desktop** | Tauri 2 Rust (`SubmenuWithItems`) | `src-tauri/src/main.rs:24-143` | macOS menu bar / Windows title bar |
| **Sidebar** | React + `lucide-react` icons | `src/components/SidebarNav.tsx` | Dashboard left sidebar (desktop) + bottom nav (mobile) |
| **Web Top Bar** | React + `lucide-react` icons | `src/components/TopMenuBar.tsx` | Browser/web mode top menu bar |

Each menu item in the native layer maps to a frontend route via the `on_menu_event` handler (`main.rs:179-278`). The Rust handler emits a `menu-navigate` event with the route string, which the frontend listens for via `@tauri-apps/api/event`.

---

## 2. Menu 1: File (ملف)

### Native Tauri Menu (`main.rs:25-36`)

| ID | Label | Shortcut | Type | Description |
|----|-------|----------|------|-------------|
| `pos` | فاتورة مبيعات جديدة | `Cmd/Ctrl+P` | Route | Opens POS register for new sale |
| `purchases_new` | فاتورة مشتريات جديدة | — | Route | Opens new purchase invoice form |
| *separator* | | | | |
| `new_window` | نافذة جديدة | `Cmd/Ctrl+N` | Action | Opens a second Tauri window at `/` |
| *separator* | | | | |
| `print` | طباعة | `Cmd/Ctrl+Shift+P` | Action | Emits `menu-action: "print"` → triggers `window.print()` |
| *separator* | | | | |
| `logout` | تسجيل الخروج | — | Action | Emits `menu-action: "logout"` → calls `logoutLocal()` → redirects to `/login` |
| *separator* | | | | |
| *quit* | خروج | | Quit | Native app quit |

### Sidebar Equivalent (`SidebarNav.tsx:38-44`)

- _No direct sidebar equivalent for File actions._ File operations are executed via keyboard shortcuts or the TopMenuBar.

### Web Top Bar Equivalent (`TopMenuBar.tsx:39-47`)

- `فاتورة مبيعات جديدة` → route `/pos`
- `فاتورة مشتريات جديدة` → route `/purchases/new`
- `طباعة` → action `print`
- `تسجيل الخروج` → action `logout`

### User Flow: New Sale

```
[File → فاتورة مبيعات جديدة] or [Ctrl+P]
  ↓
Rust: on_menu_event → match "pos" → emit("menu-navigate", "/pos")
  ↓
Frontend: listens for "menu-navigate" → router.push("/pos")
  ↓
Opens POS register page → cart is empty → pharmacist scans/adds items
  ↓
Pharmacist selects patient, applies discount, selects payment method
  ↓
Clicks "Save" → createSaleAction() → invoice + inventory deduction
  ↓
Success → receipt printed or order completed
```

---

## 3. Menu 2: Master Data (البيانات الأساسية)

### Native Tauri Menu (`main.rs:38-52`)

| ID | Label | Shortcut | Route |
|----|-------|----------|-------|
| `dashboard` | لوحة التحكم (الرئيسية) | `Cmd/Ctrl+D` | `/` |
| *separator* | | | |
| `stores_items` | الأصناف | — | `/stores/items` |
| `stores_alternatives` | البدائل | — | `/stores/alternatives` |
| `stores_categories` | التصنيفات | — | `/stores/categories` |
| `stores_nature` | النوع | — | `/stores/nature` |
| `stores_usage` | الاستخدام | — | `/stores/usage` |
| `stores_units` | الوحدات | — | `/stores/units` |
| `stores_indications` | الإشارات | — | `/stores/indications` |
| `stores_drug_indications` | الأدوية والإشارات | — | `/stores/drug-indications` |
| `stores_manufacturers` | الشركات المنتجة | — | `/stores/manufacturers` |
| `stores_scientific_groups` | المجموعات العلمية | — | `/stores/scientific-groups` |

### Sidebar Equivalent (`SidebarNav.tsx:58`)

| Route | Label | Icon | Permission |
|-------|-------|------|------------|
| `/stores/items` | إدارة المخازن | `Box` | `can_manage_inventory` |

### User Flow: Adding a New Drug

```
[Master Data → الأصناف] or [Sidebar → إدارة المخازن]
  ↓
/stores/items → Drug listing page loads with FTS5 search
  ↓
Pharmacist clicks "إضافة صنف جديد" → modal opens
  ↓
Fills: trade_name, trade_name_en, barcode, official_price, category, manufacturer
  ↓
Submits → masterDrugAction creates row in master_drugs table
  ↓
FTS trigger syncs data to master_drugs_fts virtual table
  ↓
User is redirected to item detail page
```

---

## 4. Menu 3: Inventory Operations (العمليات المخزنية)

### Native Tauri Menu (`main.rs:55-65`)

| ID | Label | Shortcut | Route | Permission |
|----|-------|----------|-------|------------|
| `inventory` | المخزون | `Cmd/Ctrl+I` | `/inventory` | — |
| `stores_shortages` | كشكول النواقص | — | `/stores/shortages` | `can_view_shortages` |
| `inventory_item_movements` | حركات الأصناف | — | `/inventory/item-movements` | `manage_inventory` |
| `restock` | إعادة التموين | — | `/restock` | `can_view_restock` |
| `inventory_opening_balances` | الأرصدة الإفتتاحية | — | `/inventory/opening-balances` | `can_view_opening_balances` |
| `stores_adjustments` | التعديلات | — | `/stores/adjustments` | — |
| `stores_adjustment_reasons` | أسباب التعديل | — | `/stores/adjustment-reasons` | — |
| `inventory_settlement` | تسوية المخزون | — | `/inventory/settlement` | `can_view_settlement` |
| `stores_delete_items` | حذف الأصناف | — | `/stores/delete-items` | — |

### Sidebar Equivalent (`SidebarNav.tsx:47-52`)

| Route | Label | Icon | Permission |
|-------|-------|------|------------|
| `/inventory` | المخزون | `Package` | — |
| `/stores/shortages` | كشكول النواقص | `AlertTriangle` | `can_view_shortages` |
| `/inventory/item-movements` | حركات الأصناف | `Activity` | `manage_inventory` |
| `/restock` | إعادة التموين | `Package` | `can_view_restock` |
| `/inventory/opening-balances` | الأرصدة الإفتتاحية | `Database` | `can_view_opening_balances` |
| `/inventory/settlement` | تسوية المخزون | `ArrowLeftRight` | `can_view_settlement` |

### User Flow: Stock Adjustment (Write-off)

```
[Inventory Ops → التعديلات]
  ↓
/stores/adjustments → list of recent adjustments
  ↓
User clicks "إضافة تعديل" → modal form
  ↓
Selects drug from inventory → enters new quantity or delta
  ↓
Selects reason from adjustment_reasons (تلف/انتهاء صلاحية/جرد)
  ↓
Submits → stock_adjustments row created →
    inventory.quantity updated →
    activity_log entry added
  ↓
List refreshes with new adjustment at top
```

---

## 5. Menu 4: Sales (المبيعات)

### Native Tauri Menu (`main.rs:68-75`)

| ID | Label | Route | Permission |
|----|-------|-------|------------|
| `receipts` | الفواتير | `/receipts` | `can_view_receipts` |
| `sales` | المبيعات والتحصيل | `/sales` | — |
| `sales_delivery` | توصيل منزلي | `/sales/delivery` | `can_view_delivery` |
| `sales_cogs` | تعديل التكلفة | `/sales/cogs` | `can_view_cogs` |
| `sales_settlement` | تسوية المبيعات | `/sales/settlement` | `can_view_settlement` |
| `returns` | مرتجعات العملاء | `/returns` | `can_view_returns` |

### Sidebar Equivalent (`SidebarNav.tsx:38-44`)

Same as above with icons: `FileText`, `ShoppingCart`, `Bike`, `Edit3`, `ArrowLeftRight`, `RotateCcw`. Role-gated: most items visible to `owner/admin/pharmacist`, COGS and Sales Settlement restricted to `owner/admin`.

### User Flow: Full POS Checkout

```
[Sales → المبيعات والتحصيل] or [Ctrl+P from File menu]
  ↓
/Sales → invoice list (filtered by status, date, user)
  ↓
Click "فاتورة جديدة" → /pos opens
  ↓
Search/add items by name or barcode → items added to cart
  ↓
Select patient (optional) → applies credit limit if credit payment
  ↓
Apply discount (line-item % or total value)
  ↓
Select payment method: cash / credit / check / visa
  ↓
Complete sale → createSaleAction():
    1. INSERT sales_invoices + sales_items
    2. UPDATE inventory SET quantity = quantity - sold
    3. INSERT patient_transactions (if credit)
    4. INSERT activity_log
  ↓
Receipt confirmation → redirect to receipt detail
```

---

## 6. Menu 5: Purchases (المشتريات)

### Native Tauri Menu (`main.rs:78-84`)

| ID | Label | Route | Permission |
|----|-------|-------|------------|
| `purchases` | المشتريات | `/purchases` | `can_view_purchases` |
| `purchase_orders` | أوامر الشراء | `/purchase-orders` | — |
| `purchases_suppliers` | الموردون | `/purchases/suppliers` | — |
| `purchases_returns` | مرتجعات للموردين | `/purchases/returns` | — |
| `purchases_general_returns` | مرتجعات عامة | `/purchases/general-returns` | — |

### Sidebar Equivalent (`SidebarNav.tsx:55`)

| Route | Label | Icon | Permission |
|-------|-------|------|------------|
| `/purchases` | المشتريات | `ShoppingCart` | `can_view_purchases` |

### User Flow: Create Purchase Invoice

```
[Purchases → المشتريات] or [File → فاتورة مشتريات جديدة]
  ↓
/purchases → 6-card navigation dashboard
  ↓
Click "فاتورة شراء" → /purchases/new
  ↓
Select supplier → balance displayed →
    checkSupplierPendingInvoiceAction() checks for uncompleted invoice
    ⚠ If pending found: toast warning with "استكمال الفاتورة" button
  ↓
Fill header: invoice number, date, payment method (cash/credit/check)
  ↓
Search drugs → add to cart → fill: quantity, bonus, cost_price,
    selling_price, expiry_date, tax %, discount %
  ↓
Total auto-calculates (subtotal + expenses - discount)
  ↓
Click "حفظ نهائي" → createPurchaseInvoiceAction():
    1. INSERT purchase_invoices header
    2. For each item: INSERT purchase_invoice_items
    3. If completed: INSERT inventory (qty + bonus)
    4. UPDATE purchase_invoices SET total_amount
    5. INSERT daily_journals + journal_entries (debit inventory)
    6. If credit/check: UPDATE suppliers.balance, INSERT supplier_transactions
    7. If cash: INSERT cash_movements (disbursement)
    8. INSERT activity_log
  ↓
Prompt: barcode printing or redirect to /purchases
```

---

## 7. Menu 6: Finance (المالية)

### Native Tauri Menu (`main.rs:87-96`)

| ID | Label | Route | Permission |
|----|-------|-------|------------|
| `accounts` | الحسابات والمالية | `/accounts` | `rep_can_view_financial` |
| `accounts_cash_transactions` | حركة النقدية | `/accounts/cash-transactions` | `can_view_cash_transactions` |
| `finance_handover` | تسليم الدرج | `/finance/handover` | `acc_can_view_handover` |
| `finance_banks` | البنوك | `/finance/banks` | `can_view_banks` |
| `finance_cards` | البطاقات والماكينات | `/finance/cards` | `can_view_cards` |
| `finance_pos_management` | إدارة نقاط البيع | `/finance/pos-management` | `can_view_pos_management` |
| `finance_accounts` | شجرة الحسابات | `/finance/accounts` | `can_view_accounts_tree` |
| `accounts_settings_trial_balance` | إعدادات ميزان المراجعة | `/accounts/settings/trial-balance` | `can_view_trial_balance` |

### Sidebar Equivalent (`SidebarNav.tsx:61-68`)

Same as above with icons: `Wallet`, `ArrowLeftRight`, `Landmark`, `CreditCard`, `Monitor`, `Database`, `Settings`. All gated behind `rep_can_view_financial` or specific `can_view_*` permission.

### User Flow: Drawer Handover (End of Shift)

```
[Finance → تسليم الدرج]
  ↓
/finance/handover → list of previous handovers
  ↓
User clicks "تسليم جديد" → form shows:
    Expected ending cash (calculated from shift sales + opening balance)
    Actual ending cash (user enters count)
  ↓
Discrepancy = actual - expected (shown in red if > 0)
  ↓
User enters notes (optional), marks as verified
  ↓
On submit:
    INSERT into cash_movements (type: handover)
    UPDATE shifts SET ending_cash, status = 'closed'
    INSERT activity_log
  ↓
Company policy: discrepancy > 5 EGP requires manager approval
```

---

## 8. Menu 7: Reports (التقارير)

### Native Tauri Menu (`main.rs:99-107`)

| ID | Label | Route | Permission |
|----|-------|-------|------------|
| `reports` | لوحة التقارير | `/reports` | `can_view_reports_dashboard` |
| `reports_sales2` | تقارير المبيعات | `/reports/sales` | `rep_can_view_sales` |
| `reports_purchases` | تقارير المشتريات | `/reports/purchases` | `can_view_purchase_reports` |
| `reports_trial_balance` | ميزان المراجعة | `/reports/trial-balance` | `can_view_trial_balance_report` |
| `expenses` | المصروفات | `/expenses` | `can_view_expenses` |
| `shifts` | الشفتات النقدية | `/shifts` | `can_view_shifts` |
| `shifts_report` | تقرير الشفتة | `/shifts/report` | `can_view_shifts` |

### Sidebar Equivalent (`SidebarNav.tsx:70-76`)

Same with icons: `BarChart3`, `TrendingUp`, `ScrollText`, `Database`, `Receipt`, `Calendar`.

### User Flow: View Sales Report

```
[Reports → تقارير المبيعات]
  ↓
/reports/sales → report with filters (date range, user, payment method)
  ↓
User sets: "Last 30 days" → "Pharmacist A" → "Cash payments"
  ↓
Backend: getPurchaseReportsAction() builds dynamic SQL with WHERE filters
  ↓
Returns aggregated data (total sales, invoice count, avg per invoice)
  ↓
Frontend renders: summary KPIs + table of invoices + chart
  ↓
User can export to CSV or print
```

---

## 9. Menu 8: Patients & Medical (المرضى والطبية)

### Native Tauri Menu (`main.rs:110-113`)

| ID | Label | Route | Permission |
|----|-------|-------|------------|
| `patients` | المرضى | `/patients` | `can_view_patients` |
| `interactions` | التفاعلات الدوائية | `/interactions` | — |

### Sidebar Equivalent (`SidebarNav.tsx:79`)

| Route | Label | Icon | Permission |
|-------|-------|------|------------|
| `/patients` | المرضى | `Users` | `can_view_patients` |

### User Flow: Drug Interaction Check

```
[Patients → التفاعلات الدوائية]
  ↓
/interactions → search form with two ingredient fields
  ↓
User enters "warfarin" in ingredient A, "aspirin" in ingredient B
  ↓
Backend: SELECT * FROM drug_interactions WHERE
    (ingredient_a = 'warfarin' AND ingredient_b = 'aspirin')
    OR (ingredient_a = 'aspirin' AND ingredient_b = 'warfarin')
  ↓
Result: CRITICAL severity → "خطر نزيف حاد" with recommendation
  ↓
Pharmacist sees alert → prescribes alternative (e.g., paracetamol)
```

---

## 10. Menu 9: Administration (الإدارة)

### Native Tauri Menu (`main.rs:116-122`)

| ID | Label | Route | Permission |
|----|-------|-------|------------|
| `staff` | أداء الموظفين | `/staff` | `can_view_staff_performance` |
| `staff_manage` | إدارة الموظفين | `/staff/manage` | `can_view_staff_manage` |
| `staff_roles` | الوظائف والرواتب | `/staff/roles` | `can_view_staff_roles` |
| `audit` | سجل المراقبة | `/audit` | `can_view_audit` (owner only) |
| `settings` | الإعدادات | `/settings` | `can_view_settings` |

### Sidebar Equivalent (`SidebarNav.tsx:82-86`)

Same with icons: `UserCheck`, `UserCog`, `Briefcase`, `Shield`, `Settings`. Audit is owner-only; all others require `owner/admin`.

### User Flow: Create New Staff User

```
[Administration → إدارة الموظفين]
  ↓
/staff/manage → user list with role badges
  ↓
Owner clicks "إضافة موظف" → modal form
  ↓
Fills: username, full_name, selects role (owner/admin/manager/pharmacist/cashier)
  ↓
Sets permissions via PermissionSet checkboxes (49 keys):
    can_view_receipts, can_manage_inventory, can_sell_credit, etc.
  ↓
On submit:
    1. bcrypt hash of password
    2. INSERT INTO users (id, username, password_hash, role, permissions, ...)
    3. INSERT activity_log
  ↓
New user can login, sees only permitted sidebar items
```

---

## 11. Menu 10: Help (مساعدة)

### Native Tauri Menu (`main.rs:125-130`)

| ID | Label | Shortcut | Type | Description |
|----|-------|----------|------|-------------|
| `update_program` | تحديث البرنامج | — | Action | Emits `menu-action: "update"` → triggers Tauri auto-updater |
| *separator* | | | | |
| `help_shortcuts` | اختصارات لوحة المفاتيح | — | Action | Emits `menu-action: "shortcuts"` → opens keyboard shortcuts modal |
| `help_about` | عن النظام | — | Action | Emits `menu-action: "about"` → opens about dialog (version, app name) |

### Event Handling (`main.rs:204-215`)

All help actions emit a `menu-action` event with a string identifier. The frontend `TopMenuBar.tsx` listens for these via a Tauri event listener (`@tauri-apps/api/event.listen('menu-action')`) and dispatches to the appropriate modal.

---

## 12. Menu Render Order

The **order of menu placement** in the native bar (left-to-right on macOS/Windows) is determined by the order of items in the `Menu::with_items()` call at `main.rs:132-143`. The Rust array is constructed **reversed** — the last item appears on the far left:

```
┌─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┐
│ Help│Rprts│Admin│Pats │Finan│Purch│Sales│Inv.O│Mstr │File │
├─────┼─────┼─────┼─────┼─────┼─────┼─────┼─────┼─────┼─────┤
│ مساعدة │ تقارير │ إدارة │ مرضى │ مالية │ مشتريات │ مبيعات │مخزنية│أساسية│ ملف│
└─────┴─────┴─────┴─────┴─────┴─────┴─────┴─────┴─────┴─────┘
```

---

## 13. Menu-to-Route Mapping Summary

**Total native menu items: 62** (48 route items + 6 action items + 8 separators + 1 quit)

| Menu | Route Items | Action Items | Separators |
|------|-------------|--------------|------------|
| File (ملف) | 2 | 3 | 4 + quit |
| Master Data (أساسية) | 11 | 0 | 1 |
| Inventory Ops (مخزنية) | 9 | 0 | 0 |
| Sales (مبيعات) | 6 | 0 | 0 |
| Purchases (مشتريات) | 5 | 0 | 0 |
| Finance (مالية) | 8 | 0 | 0 |
| Reports (تقارير) | 7 | 0 | 0 |
| Patients (مرضى) | 2 | 0 | 0 |
| Admin (إدارة) | 5 | 0 | 0 |
| Help (مساعدة) | 0 | 3 | 1 |

---

## 14. Event Routing Architecture

```
Rust (main.rs:179-278)
  │
  ├── Menu click → on_menu_event(event)
  │     │
  │     ├── Action items → emit("menu-action", action_name)
  │     │     ├── "print"    → window.print()
  │     │     ├── "logout"   → logoutLocal() + router.push('/login')
  │     │     ├── "update"   → Tauri updater check
  │     │     ├── "shortcuts" → show keyboard shortcuts modal
  │     │     └── "about"    → show about modal
  │     │
  │     ├── "new_window"    → tauri::WebviewWindowBuilder::new()
  │     │
  │     └── Route items     → emit("menu-navigate", route_string)
  │           │
  │           └── Frontend event listener → router.push(route)
  │
  └── Frontend (listens in useEffect)
        ├── listen('menu-navigate', (event) => router.push(event.payload))
        └── listen('menu-action', (event) => dispatchAction(event.payload))
```

---

## 15. Permission Enforcement by Role

| Role | Sidebar Items Visible | Backend Actions Available | Key Restrictions |
|------|----------------------|--------------------------|------------------|
| **owner** | All 31 items | All actions | Full access |
| **admin** | All 31 items | All actions | Full access |
| **manager** | ~24 items | Inventory, purchases, staff roles | No staff manage, no audit |
| **pharmacist** | ~10 items | POS, patients, returns, shifts | No purchases, no finance, no admin |
| **cashier** | ~5 items | POS, returns | No inventory, no patients, no reports |
