// Event timestamps are UTC instants; business dates are local calendar values.
export function localDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function localMonth(date = new Date()): string {
  return localDate(date).slice(0, 7);
}

export function isBusinessDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export function parseBusinessDate(value: string): Date {
  if (!isBusinessDate(value)) return new Date(Number.NaN);
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function normalizeUtcTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const timestamp = value.trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(timestamp)) {
    return `${timestamp.replace(' ', 'T')}Z`;
  }
  return timestamp;
}
