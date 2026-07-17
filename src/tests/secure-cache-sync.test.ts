import { secureCache } from '../lib/cache/secure_cache';
import { addInventoryAction } from '../app/actions-client/inventory';
import { searchMasterDrugsAction } from '../app/actions-client/master-drugs';
import { getDatabase } from '../lib/db/client';

// Mock uuid to avoid node_modules ESM export issue
jest.mock('uuid', () => ({
  v4: () => 'test-uuid'
}));

// Mock revalidatePath
jest.mock('next/cache', () => ({
  revalidatePath: jest.fn(),
}));

// Unmock inventory actions to use the real implementation for this test
jest.unmock('../app/actions-client/inventory');
jest.unmock('@/app/actions-client/inventory');

// Mock getLocalSession and hasPermission
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: () => Promise.resolve({
    id: 'test-user',
    username: 'test-user',
    role: 'owner',
    pharmacy_id: 'ph-test'
  }),
  hasPermission: () => Promise.resolve(true),
  hasUserPermissionSync: () => true
}));

describe('secureCache synchronization tests', () => {
  beforeAll(async () => {
    // Clear and prepare test database
    const db = getDatabase();
    db.prepare('DELETE FROM master_drugs WHERE id = 9999').run();
    db.prepare('DELETE FROM inventory WHERE drug_id = 9999').run();
    db.prepare(`
      INSERT INTO master_drugs (id, trade_name, trade_name_en, official_price, is_medicine, stop_dealing)
      VALUES (9999, 'Cardixin Test', 'Cardixin Test', 10.0, 1, 0)
    `).run();
    
    // Force cache reload to make sure it includes the test drug
    await secureCache.reload();
  });

  afterAll(() => {
    const db = getDatabase();
    db.prepare('DELETE FROM master_drugs WHERE id = 9999').run();
    db.prepare('DELETE FROM inventory WHERE drug_id = 9999').run();
  });

  it('verifies that adding inventory updates master_drugs and secureCache large_to_medium', async () => {
    // 1. Initial check: Cache has the drug but strips per box is not set
    const drugBefore = secureCache.getDrug(9999);
    expect(drugBefore).toBeDefined();
    expect(drugBefore?.large_to_medium).toBeFalsy();

    // 2. Add inventory with large_to_medium = 2
    const res = await addInventoryAction({
      pharmacy_id: 'ph-test',
      drug_id: 9999,
      quantity: 10,
      local_selling_price: 12.0,
      expiry_date: '2028-12-31',
      barcode: '123456789',
      unit: 'علبة',
      large_to_medium: 2
    });

    expect(res.success).toBe(true);

    // 3. Verify in cache
    const drugAfter = secureCache.getDrug(9999);
    expect(drugAfter?.large_to_medium).toBe(2);

    // 4. Verify searchMasterDrugsAction returns updated value
    const searchRes = await searchMasterDrugsAction('Cardixin Test');
    expect(searchRes.success).toBe(true);
    const found = searchRes.data?.find((d: any) => d.id === 9999);
    expect(found).toBeDefined();
    expect(found?.large_to_medium).toBe(2);
  });
});
