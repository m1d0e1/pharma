const mockDbSelect = jest.fn(async (sql: string, params: any[] = []) => {
  if (sql.includes('SELECT DISTINCT ingredient_a, ingredient_b FROM drug_interactions')) {
    return [{ ingredient_a: 'Sulpiride', ingredient_b: 'Digoxin' }];
  }

  if (sql.includes('FROM drug_interactions') && sql.includes('ingredient_a IN')) {
    expect(params).toEqual(['Digoxin', 'Sulpiride', 'Digoxin', 'Sulpiride']);
    return [{
      severity: 'major',
      ingredient_a: 'Sulpiride',
      ingredient_b: 'Digoxin',
      description_en: 'The risk or severity of adverse effects can be increased when Sulpiride is combined with Digoxin.',
      description_ar: null,
      recommendation: null,
    }];
  }

  return [];
});

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (sql: string, params?: any[]) => mockDbSelect(sql, params),
  dbGet: jest.fn(),
  dbExecute: jest.fn(),
  dbTransaction: jest.fn(async (cb: any) => cb()),
}));

describe('Cardixin + Colona interaction check', () => {
  it('detects Colona Sulpiride interaction with Cardixin Digoxine in POS', async () => {
    const { checkDrugInteractions } = await import('@/app/actions-client/interactions');

    const result = await checkDrugInteractions(['DIGOXINE', 'MEBEVERINE + SULPIRIDE']);

    expect(result.success).toBe(true);
    expect(result.data?.interactions).toEqual([
      expect.objectContaining({
        severity: 'major',
        ingredient_a: 'Sulpiride',
        ingredient_b: 'Digoxin',
      }),
    ]);
  });
});
