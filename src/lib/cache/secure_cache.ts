import { dbSelect } from '@/lib/db/tauri';
import { isTauri } from '@/lib/env';
import {
  DRUG_CATALOG_CHANGED_STORAGE_KEY,
  DRUG_IDENTITY_CHANGED_STORAGE_KEY,
} from '@/lib/inventory/refresh';

export interface MasterDrug {
  id: number;
  trade_name: string;
  generic_name: string;
  strength: string;
  unit: string;
  category: string;
  manufacturer: string;
  base_price: number;
  active_ingredient: string;
  official_price: number;
  trade_name_en: string;
  barcode: string;
  large_to_medium?: number;
  medium_to_small?: number;
  large_unit?: string;
  medium_unit?: string;
  small_unit?: string;
  reorder_point?: number;
  stop_dealing?: number;
  is_medicine?: number;
  is_service?: number;
  has_expiry?: number;
}

export interface DrugInteraction {
  id: number;
  ingredient_a: string;
  ingredient_b: string;
  severity: string;
  description_ar: string;
  description_en: string;
  recommendation: string;
}

class SecureCache {
  private drugs: Map<number, MasterDrug> = new Map();
  private drugsList: MasterDrug[] = [];
  private loaded: boolean = false;
  private loadingPromise: Promise<void> | null = null;
  private loadGeneration: number = 0;

  loadSync() {
    // Deprecated. SQLite is async only.
  }

  async load() {
    if (this.loaded) return;
    if (this.loadingPromise) return this.loadingPromise;

    const generation = this.loadGeneration;
    this.loadingPromise = (async () => {
      try {
        console.log('Loading drugs from SQLite into cache (minimal columns)...');
        
        // Only fetch the columns actually used by enrich() - NOT SELECT *
        // This reduces IPC data from ~50MB to ~5MB for 191K rows
        const drugsList = await dbSelect<MasterDrug>(`
          SELECT id, trade_name, trade_name_en, generic_name, active_ingredient,
                 barcode, manufacturer, is_medicine, is_service, stop_dealing,
                 official_price, has_expiry,
                 large_unit, medium_unit, small_unit, large_to_medium, medium_to_small
          FROM master_drugs
        `);

        if (generation !== this.loadGeneration) return;
        
        // ponytail: skip loading 191K interactions into memory — queried per-drug on demand
        
        const drugs = new Map<number, MasterDrug>();
        for (const drug of drugsList) drugs.set(drug.id, drug);

        if (generation !== this.loadGeneration) return;
        this.drugsList = drugsList;
        this.drugs = drugs;

        this.loaded = true;
        console.log(`Loaded ${this.drugsList.length} drugs into memory cache.`);
      } catch (error) {
        console.error('Failed to load drugs payload from SQLite:', error);
      } finally {
        if (generation === this.loadGeneration) this.loadingPromise = null;
      }
    })();

    return this.loadingPromise;
  }

  async reload() {
    this.loadGeneration += 1;
    this.loaded = false;
    this.loadingPromise = null;
    this.drugs.clear();
    this.drugsList = [];
    await this.load();
  }

  updateDrug(id: number, fields: Partial<MasterDrug>) {
    const drug = this.drugs.get(id);
    if (drug) {
      Object.assign(drug, fields);
    }
  }

  addDrug(drug: MasterDrug) {
    if (!this.loaded) return;
    const existing = this.drugs.get(drug.id);
    if (existing) {
      Object.assign(existing, drug);
      return;
    }
    this.drugs.set(drug.id, drug);
    this.drugsList.push(drug);
  }

  getDrug(id: number): MasterDrug | undefined {
    return this.drugs.get(id);
  }

  getAllDrugs(): MasterDrug[] {
    return this.drugsList;
  }

  /** Get the best display name for a drug by its ID */
  getDisplayName(drugId: number, dbTradeName?: string, dbIngredient?: string, dbManufacturer?: string): string {
    const drug = this.drugs.get(drugId);
    const isSecure = (s?: string | null) => !s || s === 'SECURE' || s === 'Secure';
    if (!isSecure(drug?.trade_name)) return drug!.trade_name;
    if (!isSecure(drug?.trade_name_en)) return drug!.trade_name_en;
    if (!isSecure(dbTradeName)) return dbTradeName!;
    if (drug?.active_ingredient) return drug.active_ingredient;
    if (dbIngredient) return dbIngredient;
    return `صنف غير معروف (${drugId})`;
  }

  getAllInteractions(): DrugInteraction[] {
    // ponytail: interactions not cached anymore — always query on demand
    return [];
  }

  enrich(items: any[]) {
    return items.map(item => {
      const id = item.drug_id ?? item.id;
      const cached = this.drugs.get(id);
      if (cached) {
        const isSecure = (s?: string) => !s || s === 'SECURE' || s === 'Secure';
        
        return {
          ...item,
          trade_name: isSecure(item.trade_name) ? cached.trade_name : item.trade_name,
          trade_name_en: isSecure(item.trade_name_en) ? cached.trade_name_en : item.trade_name_en,
          generic_name: isSecure(item.generic_name) ? cached.generic_name : item.generic_name,
          active_ingredient: isSecure(item.active_ingredient) ? cached.active_ingredient : item.active_ingredient,
          barcode: isSecure(item.barcode) ? cached.barcode : item.barcode,
          manufacturer: isSecure(item.manufacturer) ? cached.manufacturer : item.manufacturer,
          is_medicine: cached.is_medicine ?? item.is_medicine,
          is_service: cached.is_service ?? item.is_service,
          stop_dealing: cached.stop_dealing ?? item.stop_dealing,
          has_expiry: cached.has_expiry ?? item.has_expiry,
        };
      }
      return item;
    });
  }
}

export const secureCache = new SecureCache();

// Auto-preload in background as soon as the module is imported.
// In Tauri (client-side), this fires when the app first loads any action,
// so the cache is ready before the user clicks any search field.
if (isTauri) {
  if (typeof window !== 'undefined') {
    const listenerKey = '__pharmaSecureCacheIdentityStorageListener';
    const existing = (window as any)[listenerKey] as ((event: StorageEvent) => void) | undefined;
    if (existing) window.removeEventListener('storage', existing);
    const handleIdentityChange = (event: StorageEvent) => {
      if (
        event.key !== DRUG_IDENTITY_CHANGED_STORAGE_KEY
        && event.key !== DRUG_CATALOG_CHANGED_STORAGE_KEY
      ) return;
      secureCache.reload().catch(error => {
        console.warn('Reload catalog after cross-window catalog change', error);
      });
    };
    (window as any)[listenerKey] = handleIdentityChange;
    window.addEventListener('storage', handleIdentityChange);
  }
  // Small delay to avoid blocking initial page render
  setTimeout(() => {
    secureCache.load().catch(() => {});
  }, 500);
}
