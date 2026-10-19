import { recordedCatalogPurchaseCost } from '../catalog-cost-default';

describe('catalog purchase cost must not be inferred from retail selling price', () => {
  it.each([undefined, null, '', '  ', 0, '0', false, true, [], {}, Number.NaN,
    Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, '-5', 'NaN',
    'Infinity', '4.001', 4.001, 1_000_000_001, '1e100'])
  ('leaves absent, forged, subcent or unverified acquisition cost unresolved: %s', value => {
    expect(recordedCatalogPurchaseCost(value)).toBe(0);
  });

  it.each([2, '2', ' 5.00 ', 5, 0.3, '25.13', 123.45])
  ('accepts a recorded explicit cent-exact supplier base cost: %s', value => {
    expect(recordedCatalogPurchaseCost(value)).toBe(Number(value));
  });

  it('does not default a product with retail price 5 and unverified base to 5 cost', () => {
    const catalog = { official_price: 5, base_price: 0 };
    expect(recordedCatalogPurchaseCost(catalog.base_price)).toBe(0);
    expect(recordedCatalogPurchaseCost(catalog.base_price)).not.toBe(catalog.official_price);
  });
});
