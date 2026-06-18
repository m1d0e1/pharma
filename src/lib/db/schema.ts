import { z } from 'zod';

// User Schema
export const UserSchema = z.object({
  id: z.string().uuid(),
  username: z.string().min(3).max(50),
  password_hash: z.string(),
  pharmacy_id: z.string().uuid(),
  role: z.enum(['owner', 'manager', 'pharmacist', 'cashier']),
  permissions: z.array(z.string()),
  full_name: z.string().optional(),
  is_active: z.boolean().default(true),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type User = z.infer<typeof UserSchema>;

export const CreateUserSchema = UserSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type CreateUser = z.infer<typeof CreateUserSchema>;

// Pharmacy Schema
export const PharmacySchema = z.object({
  id: z.string().uuid(),
  name_en: z.string().min(1),
  name_ar: z.string().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  commercial_registry: z.string().optional(),
  tax_card: z.string().optional(),
  owner_name: z.string().optional(),
  owner_phone: z.string().optional(),
  subscription_id: z.string().optional(),
  subscription_status: z.string().default('active'),
  last_sync_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
});

export type Pharmacy = z.infer<typeof PharmacySchema>;

export const CreatePharmacySchema = PharmacySchema.omit({
  id: true,
  created_at: true,
  last_sync_at: true,
});

export type CreatePharmacy = z.infer<typeof CreatePharmacySchema>;

// Master Drug Schema
export const MasterDrugSchema = z.object({
  id: z.number(),
  name_en: z.string().min(1),
  name_ar: z.string().optional(),
  trade_name: z.string().optional(),
  generic_name: z.string().optional(),
  active_ingredient: z.string().optional(),
  dosage_form: z.string().optional(),
  strength: z.string().optional(),
  manufacturer: z.string().optional(),
  barcode: z.string().optional(),
  category: z.string().optional(),
  official_price: z.number().nonnegative().default(0),
  requires_prescription: z.boolean().default(false),
  last_updated_at: z.string().datetime().nullable(),
});

export type MasterDrug = z.infer<typeof MasterDrugSchema>;

export const CreateMasterDrugSchema = MasterDrugSchema.omit({
  id: true,
  last_updated_at: true,
});

export type CreateMasterDrug = z.infer<typeof CreateMasterDrugSchema>;

// Inventory Schema
export const InventorySchema = z.object({
  id: z.string().uuid(),
  pharmacy_id: z.string().uuid(),
  drug_id: z.number(),
  batch_number: z.string().optional(),
  expiry_date: z.string().date(),
  quantity: z.number().nonnegative(),
  unit_price: z.number().nonnegative(),
  min_stock_level: z.number().int().nonnegative().default(10),
  supplier: z.string().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type Inventory = z.infer<typeof InventorySchema>;

export const CreateInventorySchema = InventorySchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
});

export type CreateInventory = z.infer<typeof CreateInventorySchema>;

// Patient Schema
export const PatientSchema = z.object({
  id: z.string().uuid(),
  pharmacy_id: z.string().uuid(),
  full_name: z.string().min(1),
  name_en: z.string().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  birth_date: z.string().date().optional().nullable(),
  gender: z.enum(['male', 'female', 'other']).optional().nullable(),
  insurance_number: z.string().optional().nullable(),
  credit_limit: z.number().nonnegative().default(0),
  points_balance: z.number().nonnegative().default(0),
  customer_type: z.string().default('individual'),
  notes: z.string().optional(),
  created_at: z.string().datetime(),
});

export type Patient = z.infer<typeof PatientSchema>;

export const CreatePatientSchema = PatientSchema.omit({
  id: true,
  created_at: true,
});

export type CreatePatient = z.infer<typeof CreatePatientSchema>;

// Sales Invoice Schema
export const SalesInvoiceSchema = z.object({
  id: z.string().uuid(),
  pharmacy_id: z.string().uuid(),
  user_id: z.string().uuid(),
  patient_id: z.string().uuid().nullable(),
  total_amount: z.number().nonnegative(),
  payment_method: z.string().optional(),
  created_at: z.string().datetime(),
});

export type SalesInvoice = z.infer<typeof SalesInvoiceSchema>;

export const CreateSalesInvoiceSchema = SalesInvoiceSchema.omit({
  id: true,
  created_at: true,
});

export type CreateSalesInvoice = z.infer<typeof CreateSalesInvoiceSchema>;

// Sales Item Schema
export const SalesItemSchema = z.object({
  id: z.string().uuid(),
  invoice_id: z.string().uuid(),
  inventory_id: z.string().uuid(),
  quantity_sold: z.number().nonnegative(),
  unit_price: z.number().nonnegative(),
  created_at: z.string().datetime(),
});

export type SalesItem = z.infer<typeof SalesItemSchema>;

export const CreateSalesItemSchema = SalesItemSchema.omit({
  id: true,
  created_at: true,
});

export type CreateSalesItem = z.infer<typeof CreateSalesItemSchema>;

// Shift Register Schema
export const ShiftRegisterSchema = z.object({
  id: z.string().uuid(),
  pharmacy_id: z.string().uuid(),
  user_id: z.string().uuid(),
  starting_cash_amount: z.number().nonnegative(),
  ending_cash_amount: z.number().nonnegative().nullable(),
  opening_notes: z.string().optional(),
  closing_notes: z.string().optional(),
  shift_start: z.string().datetime(),
  shift_end: z.string().datetime().nullable(),
  status: z.enum(['open', 'closed', 'discrepancy']),
  verified_by: z.string().uuid().nullable(),
  verified_at: z.string().datetime().nullable(),
});

export type ShiftRegister = z.infer<typeof ShiftRegisterSchema>;

export const CreateShiftRegisterSchema = ShiftRegisterSchema.omit({
  id: true,
  shift_start: true,
  shift_end: true,
  verified_at: true,
});

export type CreateShiftRegister = z.infer<typeof CreateShiftRegisterSchema>;

// Sync Queue Schema
export const SyncQueueSchema = z.object({
  id: z.string().uuid(),
  operation_type: z.string(),
  table_name: z.string(),
  record_id: z.string(),
  payload: z.any(), // JSON object
  status: z.enum(['pending', 'synced', 'failed']),
  error_message: z.string().nullable(),
  created_at: z.string().datetime(),
  attempted_at: z.string().datetime().nullable(),
});

export type SyncQueue = z.infer<typeof SyncQueueSchema>;

export const CreateSyncQueueSchema = SyncQueueSchema.omit({
  id: true,
  created_at: true,
  attempted_at: true,
});

export type CreateSyncQueue = z.infer<typeof CreateSyncQueueSchema>;

// Audit Log Schema
export const AuditLogSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  pharmacy_id: z.string().uuid(),
  action_type: z.string(),
  table_name: z.string().nullable(),
  record_id: z.string().nullable(),
  details: z.any(), // JSON object
  ip_address: z.string().nullable(),
  user_agent: z.string().nullable(),
  created_at: z.string().datetime(),
});

export type AuditLog = z.infer<typeof AuditLogSchema>;

export const CreateAuditLogSchema = AuditLogSchema.omit({
  id: true,
  created_at: true,
});

export type CreateAuditLog = z.infer<typeof CreateAuditLogSchema>;

// Refill Reminder Schema
export const RefillReminderSchema = z.object({
  id: z.string().uuid(),
  patient_id: z.string().uuid(),
  drug_id: z.number(),
  last_sold_date: z.string().date(),
  next_refill_date: z.string().date(),
  is_notified: z.boolean().default(false),
  created_at: z.string().datetime(),
});

export type RefillReminder = z.infer<typeof RefillReminderSchema>;

export const CreateRefillReminderSchema = RefillReminderSchema.omit({
  id: true,
  created_at: true,
});

export type CreateRefillReminder = z.infer<typeof CreateRefillReminderSchema>;
