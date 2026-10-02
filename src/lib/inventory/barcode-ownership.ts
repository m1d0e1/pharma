export interface BarcodeClaim {
  barcode: unknown;
  drugId?: number | string | null;
}

export interface BarcodeSelectDatabase {
  select<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface BarcodePreparedDatabase {
  prepare(sql: string): {
    all(...params: any[]): Promise<any[]>;
  };
}

type BarcodeDatabase = BarcodeSelectDatabase | BarcodePreparedDatabase;

export function normalizeBarcode(value: unknown): string | null {
  const barcode = String(value ?? '').trim();
  return barcode.length > 0 ? barcode : null;
}

function normalizeDrugId(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function selectRows<T>(
  database: BarcodeDatabase,
  sql: string,
  params: unknown[],
): Promise<T[]> {
  if ('select' in database) return database.select<T>(sql, params);
  return database.prepare(sql).all(...params) as Promise<T[]>;
}

function conflictError(
  barcode: string,
  message?: string | ((barcode: string) => string),
) {
  return new Error(
    typeof message === 'function'
      ? message(barcode)
      : message || `Barcode ${barcode} is already assigned to another drug`,
  );
}

/**
 * Enforces the shared barcode ownership invariant:
 * one normalized barcode may belong to one drug across master_drugs and
 * positive inventory. Zero-quantity historical lot aliases do not reserve it.
 */
export async function assertBarcodeOwnershipAvailable(
  database: BarcodeDatabase,
  claims: BarcodeClaim[],
  options: {
    conflictMessage?: string | ((barcode: string) => string);
    chunkSize?: number;
  } = {},
): Promise<void> {
  const requested = new Map<string, { barcode: string; drugId: number | null }>();

  for (const claim of claims) {
    const barcode = normalizeBarcode(claim.barcode);
    if (!barcode) continue;
    const drugId = normalizeDrugId(claim.drugId);
    const key = barcode.toLowerCase();
    const existing = requested.get(key);
    if (
      existing
      && (existing.drugId === null || drugId === null || existing.drugId !== drugId)
    ) {
      throw conflictError(barcode, options.conflictMessage);
    }
    requested.set(key, { barcode, drugId });
  }

  if (requested.size === 0) return;

  const entries = [...requested.entries()];
  const chunkSize = Math.max(1, Math.min(400, Math.floor(options.chunkSize || 400)));

  for (let offset = 0; offset < entries.length; offset += chunkSize) {
    const chunk = entries.slice(offset, offset + chunkSize);
    const keys = chunk.map(([key]) => key);
    const placeholders = keys.map(() => '?').join(',');
    const rows = await selectRows<{ drug_id: number; barcode_key: string }>(
      database,
      `
        SELECT id AS drug_id, LOWER(TRIM(barcode)) AS barcode_key
        FROM master_drugs
        WHERE barcode IS NOT NULL
          AND LOWER(TRIM(barcode)) IN (${placeholders})
        UNION ALL
        SELECT drug_id, LOWER(TRIM(barcode)) AS barcode_key
        FROM inventory
        WHERE barcode IS NOT NULL
          AND (quantity IS NULL OR quantity != 0)
          AND LOWER(TRIM(barcode)) IN (${placeholders})
      `,
      [...keys, ...keys],
    );

    for (const row of rows) {
      const key = String(row.barcode_key || '').toLowerCase();
      const expected = requested.get(key);
      if (!expected) continue;
      if (expected.drugId === null || Number(row.drug_id) !== expected.drugId) {
        throw conflictError(expected.barcode, options.conflictMessage);
      }
    }
  }
}
