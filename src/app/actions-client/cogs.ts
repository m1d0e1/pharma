import { getLocalSession } from '@/lib/auth/local';
import { isStaffOwner } from '@/lib/auth/staff-policy';

// No runtime (including browser/server legacy SQL) may edit the sealed cost of
// a sold item. The previous browser implementation overwrote sales_items and
// created generic journals without an immutable correction receipt or replay
// nonce. That could contradict existing return reversals, duplicate postings
// on retry, and lose the original cost provenance. This action does not accept
// an unverifiable source in place of a dedicated native critical transaction.
//
// The future workflow needs authenticated, tenant-bound original sale/return
// receipts, a proven valuation source, append-only nonce/revision/journal
// receipts, future-return compensation and consistent reporting. Until those
// exist, neither search nor mutation can claim that a sale is correctable.
const COGS_CORRECTION_UNAVAILABLE =
  'تصحيح تكلفة المبيعات غير متاح حتى توفير قيود أصلية موثقة وطلب آمن يمنع التكرار ويتحقق من مصدر البيع والمرتجعات.';

type CogsUnavailableResult = { success: false; error: string };

async function refuseUnreceiptedCorrection(): Promise<CogsUnavailableResult> {
  try {
    const user = await getLocalSession();
    if (!isStaffOwner(user)) return { success: false, error: 'غير مصرح' };
    return { success: false, error: COGS_CORRECTION_UNAVAILABLE };
  } catch {
    // A failed session read cannot permit a correction or leak source data.
    return { success: false, error: 'تعذر التحقق من صلاحية تصحيح تكلفة المبيعات' };
  }
}

// Preserve the historical caller's typed list/result contract while keeping
// the implementation denial-only. No caller may interpret denial as an empty
// successful search.
export async function getSoldItemsForCogsAdjustmentAction(_searchTerm: string): Promise<{
  success: boolean; error?: string; data?: Array<Record<string, unknown>>;
}> {
  return refuseUnreceiptedCorrection();
}

export async function updateSoldItemCostAction(_itemId: number | string, _newCost: number) {
  return refuseUnreceiptedCorrection();
}
