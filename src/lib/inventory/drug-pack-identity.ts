/**
 * A catalog merge is destructive: it rekeys stock lots and historical invoices.
 * Numbered product identities (for example 180 versus 45 ml/bottle) cannot
 * safely be treated as one product merely because the barcode is duplicated.
 * Arabic/Eastern-Arabic digits are normalized for legacy bilingual records.
 */
export function namedProductNumbers(drug: {
  trade_name?: string | null;
  trade_name_en?: string | null;
} | null | undefined): string[] {
  const normalizeDigit = (char: string): string => {
    const point = char.codePointAt(0) || 0;
    if (point >= 0x0660 && point <= 0x0669) return String(point - 0x0660);
    if (point >= 0x06f0 && point <= 0x06f9) return String(point - 0x06f0);
    return char;
  };
  const joined = `${drug?.trade_name_en || ''} ${drug?.trade_name || ''}`;
  const ascii = Array.from(joined, normalizeDigit).join('');
  const values = (ascii.match(/[0-9]+/g) || []).map(value => value.replace(/^0+(?=\d)/, ''));
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function hasConflictingNamedPackSize(
  oldDrug: { trade_name?: string | null; trade_name_en?: string | null } | null | undefined,
  candidate: { trade_name?: string | null; trade_name_en?: string | null } | null | undefined,
): boolean {
  const oldNumbers = namedProductNumbers(oldDrug);
  const candidateNumbers = namedProductNumbers(candidate);
  return oldNumbers.length > 0 && candidateNumbers.length > 0
    && (oldNumbers.length !== candidateNumbers.length
      || oldNumbers.some((value, i) => value !== candidateNumbers[i]));
}
