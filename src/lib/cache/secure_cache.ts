import { dbSelect } from '@/lib/db/tauri';

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

  loadSync() {
    // Deprecated. SQLite is async only.
  }

  async load() {
    if (this.loaded) return;
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = (async () => {
      try {
        console.log('Loading drugs from SQLite into cache (minimal columns)...');
        
        // Only fetch the columns actually used by enrich() - NOT SELECT *
        // This reduces IPC data from ~50MB to ~5MB for 191K rows
        this.drugsList = await dbSelect<MasterDrug>(`
          SELECT id, trade_name, trade_name_en, generic_name, active_ingredient,
                 barcode, manufacturer, is_medicine, is_service, stop_dealing,
                 official_price, base_price
          FROM master_drugs
        `);
        
        // ponytail: skip loading 191K interactions into memory — queried per-drug on demand
        
        for (const drug of this.drugsList) {
          this.drugs.set(drug.id, drug);
        }

        this.loaded = true;
        console.log(`Loaded ${this.drugsList.length} drugs into memory cache.`);
      } catch (error) {
        console.error('Failed to load drugs payload from SQLite:', error);
        this.loadingPromise = null; // Allow retry on failure
      }
    })();

    return this.loadingPromise;
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
if (typeof window !== 'undefined') {
  // Small delay to avoid blocking initial page render
  setTimeout(() => {
    secureCache.load().catch(() => {});
  }, 500);
}
