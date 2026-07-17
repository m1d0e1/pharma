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

describe('searchMasterDrugsAction Active Ingredient toggle tests', () => {
  beforeAll(() => {
    const db = getDatabase();
    db.prepare('DELETE FROM master_drugs WHERE id IN (8888, 8889)').run();
    db.prepare(`
      INSERT INTO master_drugs (id, trade_name, trade_name_en, active_ingredient, official_price, is_medicine, stop_dealing)
      VALUES 
        (8888, 'Panadol Joint', 'Panadol Joint', 'Paracetamol', 15.0, 1, 0),
        (8889, 'Adol Extra', 'Adol Extra', 'Paracetamol', 12.0, 1, 0)
    `).run();
  });

  afterAll(() => {
    const db = getDatabase();
    db.prepare('DELETE FROM master_drugs WHERE id IN (8888, 8889)').run();
  });

  it('searches by name when searchByActiveIngredient = false', async () => {
    const res = await searchMasterDrugsAction({ query: 'Panadol', searchByActiveIngredient: false });
    expect(res.success).toBe(true);
    const ids = res.data?.map((d: any) => d.id) || [];
    expect(ids).toContain(8888);
    expect(ids).not.toContain(8889);
  });

  it('searches by active ingredient when searchByActiveIngredient = true', async () => {
    const res = await searchMasterDrugsAction({ query: 'Paracetamol', searchByActiveIngredient: true });
    expect(res.success).toBe(true);
    const ids = res.data?.map((d: any) => d.id) || [];
    expect(ids).toContain(8888);
    expect(ids).toContain(8889);
  });
});
