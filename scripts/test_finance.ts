process.env.PHARMA_DB_PATH = 'd:\\PhD\\Tools\\pharma\\pharma_local.db';
import { addExpenseAction } from '../src/app/actions-client/expenses';
import { addPatientPaymentAction, addFinancialNoticeAction } from '../src/app/actions-client/finance';

(globalThis as any).__MOCK_SESSION__ = {
  id: '0ce19bbe-c1da-4e9b-8a4e-283dea9fba00',
  role: 'owner',
  permissions: { rep_can_view_financial: true }
};

async function test() {
  console.log("=== Testing Finances and Accounts ===");
  try {
    const expenseRes = await addExpenseAction({
      category: '15',
      amount: 150.0,
      description: 'Test Electricity Expense',
      date: new Date().toISOString()
    });
    console.log("1. addExpenseAction:", expenseRes);

    const paymentRes = await addPatientPaymentAction({
      patient_id: 'test_patient_123',
      amount: 500.0,
      payment_method: 'cash',
      notes: 'Test Patient Payment',
      date: new Date().toISOString()
    });
    console.log("2. addPatientPaymentAction:", paymentRes);

    const noticeRes = await addFinancialNoticeAction({
      target_type: 'customer',
      target_id: 'test_patient_123',
      type: 'debit',
      amount: 200.0,
      reason: 'Test Return / Refund',
      date: new Date().toISOString()
    });
    console.log("3. addFinancialNoticeAction:", noticeRes);

  } catch (e) {
    console.error("Test failed:", e);
  }
}

test();
