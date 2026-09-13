/**
 * The permissions that an owner can actually delegate, grouped by the module
 * in which the protected action lives. Keep this list aligned with action
 * guards; the staff editor intentionally does not display legacy/dead flags.
 */
export type PermissionValueKind = 'boolean' | 'percent';

export interface PermissionDefinition {
  key: string;
  label: string;
  kind?: PermissionValueKind;
}

export interface PermissionModule {
  id: string;
  label: string;
  title: string;
  description: string;
  permissions: readonly PermissionDefinition[];
}

export const PERMISSION_MODULES: readonly PermissionModule[] = [
  {
    id: 'pos',
    label: 'نقطة البيع',
    title: 'نقطة البيع والفواتير',
    description: 'الدخول للكاشير، البيع، الخصومات، والأسعار والفواتير المعلقة',
    permissions: [
      { key: 'can_access_pos', label: 'الدخول إلى نقطة البيع' },
      { key: 'can_change_price_sale', label: 'تغيير سعر الصنف أثناء البيع' },
      { key: 'can_view_stock_sale', label: 'رؤية رصيد الصنف أثناء البيع' },
      { key: 'can_sell_no_stock', label: 'بيع صنف بلا رصيد' },
      { key: 'can_discount_sale_item', label: 'تعديل خصم كل صنف في سلة البيع' },
      { key: 'can_give_total_discount', label: 'إعطاء خصم على إجمالي الفاتورة' },
      { key: 'max_invoice_discount_percent', label: 'الحد الأقصى لخصم الفاتورة (%)', kind: 'percent' },
      { key: 'can_sell_credit', label: 'البيع بالأجل' },
      { key: 'show_suspended_invoices', label: 'عرض الفواتير المعلقة' },
      { key: 'suspended_can_save_invoice', label: 'حفظ فاتورة معلقة' },
    ],
  },
  {
    id: 'sales',
    label: 'المبيعات والمرتجعات',
    title: 'المبيعات وما بعد البيع',
    description: 'الفواتير والمرتجعات والاستبدال والتوصيل والتسوية',
    permissions: [
      { key: 'can_view_receipts', label: 'عرض سجل فواتير البيع' },
      { key: 'can_view_returns', label: 'عرض وإجراء مرتجعات البيع' },
      { key: 'can_make_exchanges', label: 'إجراء الاستبدال ضمن المرتجع' },
      { key: 'can_view_delivery', label: 'عرض وإدارة التوصيل' },
      { key: 'can_view_cogs', label: 'عرض تكلفة المبيعات' },
      { key: 'can_view_settlement', label: 'عرض تسوية المبيعات والمخزون' },
    ],
  },
  {
    id: 'purchases',
    label: 'المشتريات والموردون',
    title: 'المشتريات والموردون',
    description: 'فواتير الشراء ومرتجعاتها وأوامر الشراء ودليل الموردين',
    permissions: [
      { key: 'can_view_purchases', label: 'عرض وإدارة المشتريات ومرتجعاتها' },
      { key: 'can_view_suppliers', label: 'عرض دليل الموردين' },
    ],
  },
  {
    id: 'inventory',
    label: 'المخزون والأصناف',
    title: 'المخزون والأصناف',
    description: 'بيانات الأدوية والأرصدة والحركات والنواقص والأرصدة الافتتاحية',
    permissions: [
      { key: 'can_view_stores', label: 'عرض المخزون وبطاقات الأصناف' },
      { key: 'can_manage_inventory', label: 'إضافة وتعديل وحذف بيانات الأصناف والمخزون' },
      { key: 'can_modify_unit_conversion', label: 'تعديل معاملات تحويل الوحدات' },
      { key: 'preview_item_movements', label: 'عرض حركات الأصناف' },
      { key: 'can_view_low_stock', label: 'عرض تنبيهات إعادة الطلب' },
      { key: 'can_view_restock', label: 'عرض وإدارة كشكول النواقص وإعادة التموين' },
      { key: 'can_view_opening_balances', label: 'عرض وإدارة الأرصدة الافتتاحية' },
    ],
  },
  {
    id: 'patients',
    label: 'المرضى والطبية',
    title: 'المرضى والوظائف الطبية',
    description: 'دليل المرضى وحساباتهم والتفاعلات الدوائية',
    permissions: [
      { key: 'can_view_patients', label: 'عرض وإدارة المرضى وحساباتهم' },
      { key: 'can_delete_patients', label: 'حذف أو تعطيل سجل مريض' },
    ],
  },
  {
    id: 'finance',
    label: 'المالية والورديات',
    title: 'المالية والحسابات والورديات',
    description: 'الخزينة والحسابات والحركات النقدية والورديات والتسليم',
    permissions: [
      { key: 'acc_can_view_general', label: 'عرض الحسابات العامة' },
      { key: 'acc_can_view_pos', label: 'عرض وإدارة نقاط البيع المالية' },
      { key: 'acc_can_view_bank_accounts', label: 'عرض وإدارة الحسابات البنكية' },
      { key: 'acc_can_define_expenses', label: 'تعريف وتسجيل المصروفات' },
      { key: 'acc_can_process_cash_flow', label: 'صرف وتوريد النقدية' },
      { key: 'acc_can_view_securities', label: 'عرض وإدارة الأوراق المالية' },
      { key: 'acc_can_make_daily_entries', label: 'إنشاء القيود اليومية' },
      { key: 'acc_can_view_notifications', label: 'عرض وإدارة الإشعارات المالية' },
      { key: 'acc_can_collect_credit_cards', label: 'تحصيل ومراجعة بطاقات الائتمان' },
      { key: 'acc_can_view_reports', label: 'عرض التقارير المحاسبية' },
      { key: 'can_select_pos_financial', label: 'اختيار نقطة البيع في الحسابات' },
      { key: 'can_view_expenses', label: 'عرض شاشة المصروفات والأرباح' },
      { key: 'can_view_shifts', label: 'عرض وإدارة الورديات' },
      { key: 'acc_can_view_handover', label: 'عرض وإجراء تسليم الوردية' },
    ],
  },
  {
    id: 'reports',
    label: 'التقارير',
    title: 'التقارير والإحصاءات',
    description: 'تحديد مجموعات التقارير التي يمكن للموظف الاطلاع عليها',
    permissions: [
      { key: 'rep_can_view_sales', label: 'تقارير المبيعات' },
      { key: 'rep_can_view_purchases', label: 'تقارير المشتريات' },
      { key: 'rep_can_view_financial', label: 'تقارير المالية وحسابات المرضى' },
      { key: 'rep_can_view_shifts', label: 'تقارير الورديات' },
      { key: 'rep_can_view_activity', label: 'أداء الموظفين ومراقبة النشاط' },
    ],
  },
  {
    id: 'system',
    label: 'النظام والرقابة',
    title: 'النظام والرقابة',
    description: 'الإعدادات وسجل الرقابة وإدارة الموظفين؛ صلاحيات الكادر للمالك فقط',
    permissions: [
      { key: 'can_view_audit', label: 'عرض سجل الرقابة' },
      { key: 'can_view_settings', label: 'عرض وإدارة الإعدادات' },
      { key: 'can_view_staff_manage', label: 'إدارة حسابات الموظفين' },
      { key: 'can_view_staff_roles', label: 'إدارة المسميات والأدوار الوظيفية' },
    ],
  },
] as const;

export const DELEGATABLE_PERMISSION_KEYS = new Set(
  PERMISSION_MODULES.flatMap(module => module.permissions.map(permission => permission.key)),
);

export const STAFF_PROFILE_PERMISSION_KEYS = new Set([
  'national_id', 'address', 'birth_date', 'qualification', 'mobile',
  'gender', 'social_status', 'is_delivery_rep',
]);

export function sanitizeStaffPermissions(input: unknown): Record<string, boolean | number | string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const source = input as Record<string, unknown>;
  const sanitized: Record<string, boolean | number | string> = {};

  for (const key of [...DELEGATABLE_PERMISSION_KEYS, ...STAFF_PROFILE_PERMISSION_KEYS]) {
    if (!(key in source)) continue;
    const value = source[key];
    if (STAFF_PROFILE_PERMISSION_KEYS.has(key) && key !== 'is_delivery_rep') {
      sanitized[key] = typeof value === 'string' ? value : '';
    } else if (key === 'max_invoice_discount_percent') {
      const numeric = Number(value);
      sanitized[key] = Number.isFinite(numeric) ? Math.min(100, Math.max(0, numeric)) : 0;
    } else {
      sanitized[key] = value === true || value === 'true' || value === 1;
    }
  }
  return sanitized;
}
