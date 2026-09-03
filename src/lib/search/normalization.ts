/**
 * Normalization and alias resolution for drug searches across master-drugs and sales (POS).
 */

export function normalizeSearchText(str: unknown): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/[٠-٩]/g, d => '0123456789'['٠١٢٣٤٥٦٧٨٩'.indexOf(d)])
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .toLowerCase()
    .trim();
}

export function normalizePunctuation(str: unknown): string {
  return normalizeSearchText(str)
    .replace(/[,.\-_/\\()+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function compactSearchText(str: unknown): string {
  return normalizeSearchText(str).replace(/[^a-z0-9\u0600-\u06FF]/gi, '');
}

export const DRUG_SEARCH_ALIASES: Record<string, string[]> = {
  '1 2 3': ['one two three', '1,2,3', '1-2-3', '123', 'وان تو ثري', 'ون تو ثري'],
  '123': ['1 2 3', 'one two three', '1,2,3', '1-2-3', 'وان تو ثري', 'ون تو ثري'],
  '1,2,3': ['1 2 3', 'one two three', '123', '1-2-3', 'وان تو ثري', 'ون تو ثري'],
  '1-2-3': ['1 2 3', 'one two three', '123', '1,2,3', 'وان تو ثري', 'ون تو ثري'],
  'وان تو ثري': ['1 2 3', '1,2,3', '1-2-3', 'one two three', '123'],
  'ون تو ثري': ['1 2 3', '1,2,3', '1-2-3', 'one two three', '123'],
  'one two three': ['1 2 3', '1,2,3', '1-2-3', '123', 'وان تو ثري', 'ون تو ثري'],
};

export function getSearchVariants(rawQuery: string): {
  normalizedQuery: string;
  searchTerms: string[];
  compactQuery: string;
} {
  const norm = normalizePunctuation(rawQuery);
  const comp = compactSearchText(rawQuery);
  const terms = new Set<string>();

  if (norm) {
    terms.add(norm);
    const aliases = DRUG_SEARCH_ALIASES[norm];
    if (aliases) {
      for (const a of aliases) {
        terms.add(normalizePunctuation(a));
      }
    }
  }

  if (comp && DRUG_SEARCH_ALIASES[comp]) {
    for (const a of DRUG_SEARCH_ALIASES[comp]) {
      terms.add(normalizePunctuation(a));
    }
  }

  return {
    normalizedQuery: norm,
    searchTerms: Array.from(terms),
    compactQuery: comp
  };
}

export function matchesDrug(
  drug: any,
  variants: { searchTerms: string[]; compactQuery: string },
  searchByActive: boolean = false
): boolean {
  if (searchByActive) {
    const active = normalizePunctuation(drug.active_ingredient || drug.generic_name || '');
    const activeCompact = compactSearchText(drug.active_ingredient || drug.generic_name || '');
    for (const term of variants.searchTerms) {
      if (active.includes(term)) return true;
    }
    if (variants.compactQuery.length >= 3 && activeCompact.includes(variants.compactQuery)) {
      return true;
    }
    return false;
  }

  const barcode = (drug.barcode || '').trim().toLowerCase();
  const idStr = String(drug.id);
  const tradeAr = normalizePunctuation(drug.trade_name || '');
  const tradeEn = normalizePunctuation(drug.trade_name_en || '');
  const compactAr = compactSearchText(drug.trade_name || '');
  const compactEn = compactSearchText(drug.trade_name_en || '');

  for (const term of variants.searchTerms) {
    if (tradeAr.includes(term) || tradeEn.includes(term)) return true;
    if (barcode === term || idStr === term) return true;
  }

  if (variants.compactQuery.length >= 2) {
    if (compactAr.includes(variants.compactQuery) || compactEn.includes(variants.compactQuery)) {
      return true;
    }
    if (barcode === variants.compactQuery || idStr === variants.compactQuery) {
      return true;
    }
  }

  return false;
}

export function calculateDrugRelevance(drug: any, searchLower: string): number {
  const variants = getSearchVariants(searchLower);
  const tradeEn = normalizePunctuation(drug.trade_name_en || '');
  const tradeAr = normalizePunctuation(drug.trade_name || '');
  const compactEn = compactSearchText(drug.trade_name_en || '');
  const compactAr = compactSearchText(drug.trade_name || '');
  const active = normalizePunctuation(drug.active_ingredient || drug.generic_name || '');
  const barcode = (drug.barcode || '').toLowerCase().trim();
  const idStr = String(drug.id);

  let bestScore = 0;

  for (const term of variants.searchTerms) {
    // 1. Exact matches
    if (tradeEn === term || tradeAr === term || barcode === term || idStr === term) {
      bestScore = Math.max(bestScore, 100);
      continue;
    }
    if (variants.compactQuery.length >= 2 && (compactEn === variants.compactQuery || compactAr === variants.compactQuery)) {
      bestScore = Math.max(bestScore, 95);
      continue;
    }

    // 2. Starts-with match
    if (tradeEn.startsWith(term) || tradeAr.startsWith(term)) {
      bestScore = Math.max(bestScore, 80);
      continue;
    }
    if (variants.compactQuery.length >= 2 && (compactEn.startsWith(variants.compactQuery) || compactAr.startsWith(variants.compactQuery))) {
      bestScore = Math.max(bestScore, 75);
      continue;
    }

    // 3. Word starts-with
    const tradeEnWords = tradeEn.split(/\s+/);
    const tradeArWords = tradeAr.split(/\s+/);
    if (tradeEnWords.some((w: string) => w.startsWith(term)) || tradeArWords.some((w: string) => w.startsWith(term))) {
      bestScore = Math.max(bestScore, 70);
      continue;
    }

    // 4. Contains match
    if (tradeEn.includes(term) || tradeAr.includes(term)) {
      bestScore = Math.max(bestScore, 60);
      continue;
    }
    if (variants.compactQuery.length >= 2 && (compactEn.includes(variants.compactQuery) || compactAr.includes(variants.compactQuery))) {
      bestScore = Math.max(bestScore, 55);
      continue;
    }

    // 5. Active ingredient matches
    if (active.startsWith(term)) {
      bestScore = Math.max(bestScore, 50);
      continue;
    }
    const activeWords = active.split(/\s+/);
    if (activeWords.some((w: string) => w.startsWith(term))) {
      bestScore = Math.max(bestScore, 40);
      continue;
    }
    if (active.includes(term)) {
      bestScore = Math.max(bestScore, 30);
      continue;
    }
  }

  return bestScore;
}
