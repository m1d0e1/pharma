/** Fixed, owned native sources for the strict Windows stock-adjustment screen. */
import { isTauri } from '@/lib/env';

export interface AdjustmentReasonSource {
  id: number;
  name_ar: string;
  name_en: string | null;
}

export interface AdjustmentLotSource {
  id: string;
  drug_id: number;
  quantity: number;
  trade_name: string;
  trade_name_en: string | null;
  barcode: string | null;
}

async function readNative(queryId: string, limit: number, search: string | null): Promise<unknown[]> {
  if (!isTauri) throw Error('Native stock adjustment source requires desktop');
  const { invoke } = await import('@tauri-apps/api/core');
  const result = await invoke<unknown>('db_read_scoped', {
    queryId, recordId: null, search, drugId: null, limit, offset: 0,
  });
  if (!Array.isArray(result) || result.length > limit) {
    throw Error('Invalid authenticated stock adjustment source');
  }
  return result;
}

function record(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error('Invalid stock source row');
  return row as Record<string, unknown>;
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) {
    throw Error('Invalid stock source label');
  }
  return value;
}

function optionalText(value: unknown, max: number): string | null {
  if (value == null || value === '') return null;
  return text(value, max);
}

export async function readAdjustmentReasonsNative(): Promise<AdjustmentReasonSource[]> {
  const rows = await readNative('inventory.adjustment_reasons', 100, null);
  const seen = new Set<number>();
  return rows.map(raw => {
    const row = record(raw);
    const id = row.id;
    if (!Number.isSafeInteger(id) || (id as number) <= 0 || seen.has(id as number)) {
      throw Error('Invalid adjustment reason source identity');
    }
    seen.add(id as number);
    return { id: id as number, name_ar: text(row.name_ar, 256), name_en: optionalText(row.name_en, 256) };
  });
}

export async function searchAdjustmentLotsNative(term: string): Promise<AdjustmentLotSource[]> {
  const search = term.trim();
  if (search.length < 3 || search.length > 128 || /[\x00-\x1f]/.test(search)) {
    throw Error('Invalid stock adjustment search term');
  }
  const rows = await readNative('inventory.adjustment_lots', 20, search);
  const seen = new Set<string>();
  return rows.map(raw => {
    const row = record(raw);
    const id = text(row.id, 128);
    const drug = row.drug_id;
    const qty = row.quantity;
    if (seen.has(id) || !Number.isSafeInteger(drug) || (drug as number) <= 0 ||
        typeof qty !== 'number' || !Number.isFinite(qty) || qty < 0 || qty > 1e9) {
      throw Error('Invalid inventory adjustment source');
    }
    seen.add(id);
    return { id, drug_id: drug as number, quantity: qty,
      trade_name: text(row.trade_name, 256),
      trade_name_en: optionalText(row.trade_name_en, 256),
      barcode: optionalText(row.barcode, 128),
    };
  });
}
