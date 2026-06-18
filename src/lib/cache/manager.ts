// Cache manager for performance optimization

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

class CacheManager {
  private cache: Map<string, CacheEntry<any>> = new Map();
  private defaultTTL: number = 5 * 60 * 1000; // 5 minutes

  /**
   * Get cached data
   * @param key - Cache key
   * @returns Cached data or null
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // Check if entry is expired
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry.data as T;
  }

  /**
   * Set cached data
   * @param key - Cache key
   * @param data - Data to cache
   * @param ttl - Time to live in milliseconds
   */
  set<T>(key: string, data: T, ttl?: number): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl: ttl || this.defaultTTL,
    });
  }

  /**
   * Delete cached data
   * @param key - Cache key
   */
  delete(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Clear all cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get or set cached data
   * @param key - Cache key
   * @param factory - Function to generate data if not cached
   * @param ttl - Time to live in milliseconds
   * @returns Cached or generated data
   */
  async getOrSet<T>(
    key: string,
    factory: () => Promise<T>,
    ttl?: number
  ): Promise<T> {
    const cached = this.get<T>(key);

    if (cached !== null) {
      return cached;
    }

    const data = await factory();
    this.set(key, data, ttl);
    return data;
  }

  /**
   * Get cache size
   * @returns Number of cached entries
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Clean expired entries
   */
  clean(): void {
    const now = Date.now();

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Get cache statistics
   * @returns Cache statistics
   */
  getStats(): {
    size: number;
    keys: string[];
    totalSize: number;
  } {
    const keys = Array.from(this.cache.keys());
    const totalSize = JSON.stringify(Array.from(this.cache.values())).length;

    return {
      size: this.cache.size,
      keys,
      totalSize,
    };
  }
}

// Singleton instance
export const cache = new CacheManager();

// Cache keys
export const CACHE_KEYS = {
  INVENTORY: 'inventory',
  PATIENTS: 'patients',
  SALES: 'sales',
  REPORTS: 'reports',
  USERS: 'users',
  PHARMACY: 'pharmacy',
  DRUGS: 'drugs',
  ALERTS: 'alerts',
} as const;

// Cache TTL constants (in milliseconds)
export const CACHE_TTL = {
  SHORT: 1 * 60 * 1000, // 1 minute
  MEDIUM: 5 * 60 * 1000, // 5 minutes
  LONG: 15 * 60 * 1000, // 15 minutes
  VERY_LONG: 60 * 60 * 1000, // 1 hour
} as const;
