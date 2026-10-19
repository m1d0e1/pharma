/** Typed desktop-only catalog creation. No renderer SQL or assumed stock cost. */
import { isTauri } from '@/lib/env';

const KEY = 'pharma:native-master-drug-create:v1';
type Result = { success: boolean; id?: number; error?: string };

function text(v: unknown, max = 512): string | null {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || v.length > max || /[\x00-\x1f\x7f]/.test(v)) throw Error('Invalid catalog text');
  const s = v.trim();
  return s || null;
}

function yes(v: unknown, fallback: boolean): boolean {
  if (v == null) return fallback;
  if (v === 1 || v === true) return true;
  if (v === 0 || v === false) return false;
  throw Error('Invalid catalog flag');
}

function conversion(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v !== 'number' && typeof v !== 'string') throw Error('Invalid conversion');
  if (typeof v === 'string' && !v.trim()) throw Error('Invalid conversion');
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1 || n > 10_000) throw Error('Invalid conversion');
  return n;
}

const nonce = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);

export async function createNativeMasterDrug(data: Record<string, unknown>): Promise<Result> {
  if (!isTauri) return { success: false, error: 'Native catalog requires desktop' };
  try {
    const p = data.official_price;
    if ((typeof p !== 'number' && typeof p !== 'string') ||
        (typeof p === 'string' && !p.trim())) throw Error('Explicit retail price required');
    const officialPrice = Number(p);
    if (!Number.isFinite(officialPrice) || officialPrice < 0 || officialPrice > 1e9 ||
        Math.abs(officialPrice * 100 - Math.round(officialPrice * 100)) > 1e-7) {
      throw Error('Invalid explicit retail price');
    }
    // Match the native Rust DTO limits before a durable request nonce is
    // committed. In particular, don't trap a user behind an unreplayable
    // overlong text field that the native writer can never accept.
    const tradeName = text(data.trade_name, 160);
    if (!tradeName) throw Error('Catalog name required');
    const payload = {
      tradeName, tradeNameEn: text(data.trade_name_en, 160),
      genericName: text(data.generic_name, 160),
      activeIngredient: text(data.active_ingredient, 512),
      barcode: text(data.barcode, 128),
      officialPrice, category: text(data.category, 160),
      manufacturer: text(data.manufacturer, 160),
      isMedicine: yes(data.is_medicine, true),
      isService: yes(data.is_service, false),
      hasExpiry: yes(data.has_expiry, true),
      isRefrigerated: yes(data.is_refrigerated, false),
      isChronic: yes(data.is_chronic, false),
      noReturn: yes(data.no_return, false),
      preventFractions: yes(data.prevent_fractions, false),
      largeUnit: text(data.large_unit, 80),
      mediumUnit: text(data.medium_unit, 80),
      smallUnit: text(data.small_unit, 80),
      largeToMedium: conversion(data.large_to_medium),
      mediumToSmall: conversion(data.medium_to_small),
    };
    // Persistent hint is NOT evidence of a completed native create. Never
    // store product names, barcode or price in storage; only their digest.
    if (typeof window === 'undefined' || !window.localStorage ||
        !globalThis.crypto?.subtle || !globalThis.crypto?.randomUUID) {
      throw Error('Durable native creation intent unavailable');
    }
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)));
    const fingerprint = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
    const persisted = window.localStorage.getItem(KEY);
    let requestId: string;
    if (persisted != null) {
      const old = JSON.parse(persisted) as Record<string, unknown>;
      if (!old || old.version !== 1 || old.fingerprint !== fingerprint || !nonce(old.requestId) ||
          Object.keys(old).sort().join(',') !== 'fingerprint,requestId,version') {
        throw Error('Uncertain catalog create must be independently reconciled');
      }
      requestId = old.requestId as string;
    } else {
      requestId = crypto.randomUUID();
      if (!nonce(requestId)) throw Error('Invalid native request identity');
      window.localStorage.setItem(KEY, JSON.stringify({ version: 1, fingerprint, requestId }));
      if (window.localStorage.getItem(KEY) !== JSON.stringify({ version: 1, fingerprint, requestId })) {
        throw Error('Native request storage did not persist');
      }
    }
    const result = await (await import('@tauri-apps/api/core')).invoke<unknown>(
      'create_master_drug_native', { payload: { ...payload, requestId } },
    );
    if (!result || typeof result !== 'object' || Array.isArray(result) ||
        (result as { success?: unknown }).success !== true ||
        !Number.isSafeInteger((result as { id?: unknown }).id) ||
        Number((result as { id?: unknown }).id) <= 0 ||
        'error' in result) throw Error('Native catalog acknowledgment unverified');
    try { window.localStorage.removeItem(KEY); } catch { /* source is already confirmed */ }
    return { success: true, id: (result as { id: number }).id };
  } catch {
    return { success: false, error: 'تعذر تأكيد إنشاء الصنف؛ لا تنشئ طلباً جديداً قبل مراجعة المصدر الأصلي' };
  }
}
