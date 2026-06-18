// Performance monitoring utilities

interface PerformanceMetric {
  name: string;
  duration: number;
  timestamp: number;
  metadata?: Record<string, any>;
}

class PerformanceMonitor {
  private metrics: PerformanceMetric[] = [];
  private maxMetrics: number = 1000;

  /**
   * Start measuring performance
   * @param name - Metric name
   * @returns Stop function
   */
  start(name: string): () => void {
    const startTime = performance.now();

    return () => {
      const duration = performance.now() - startTime;
      this.record(name, duration);
    };
  }

  /**
   * Record a performance metric
   * @param name - Metric name
   * @param duration - Duration in milliseconds
   * @param metadata - Additional metadata
   */
  record(name: string, duration: number, metadata?: Record<string, any>): void {
    const metric: PerformanceMetric = {
      name,
      duration,
      timestamp: Date.now(),
      metadata,
    };

    this.metrics.push(metric);

    // Keep only the most recent metrics
    if (this.metrics.length > this.maxMetrics) {
      this.metrics.shift();
    }

    // Log slow operations
    if (duration > 1000) {
      console.warn(`Slow operation: ${name} took ${duration.toFixed(2)}ms`);
    }
  }

  /**
   * Get metrics by name
   * @param name - Metric name
   * @returns List of metrics
   */
  getMetrics(name: string): PerformanceMetric[] {
    return this.metrics.filter((m) => m.name === name);
  }

  /**
   * Get all metrics
   * @returns List of all metrics
   */
  getAllMetrics(): PerformanceMetric[] {
    return [...this.metrics];
  }

  /**
   * Get statistics for a metric
   * @param name - Metric name
   * @returns Metric statistics
   */
  getStatistics(name: string): {
    count: number;
    min: number;
    max: number;
    avg: number;
    p50: number;
    p95: number;
    p99: number;
  } | null {
    const metrics = this.getMetrics(name);

    if (metrics.length === 0) {
      return null;
    }

    const durations = metrics.map((m) => m.duration).sort((a, b) => a - b);

    const sum = durations.reduce((acc, val) => acc + val, 0);
    const avg = sum / durations.length;

    const p50Index = Math.floor(durations.length * 0.5);
    const p95Index = Math.floor(durations.length * 0.95);
    const p99Index = Math.floor(durations.length * 0.99);

    return {
      count: durations.length,
      min: durations[0],
      max: durations[durations.length - 1],
      avg,
      p50: durations[p50Index],
      p95: durations[p95Index],
      p99: durations[p99Index],
    };
  }

  /**
   * Clear all metrics
   */
  clear(): void {
    this.metrics = [];
  }

  /**
   * Get slow operations
   * @param threshold - Threshold in milliseconds
   * @returns List of slow operations
   */
  getSlowOperations(threshold: number = 1000): PerformanceMetric[] {
    return this.metrics.filter((m) => m.duration > threshold);
  }

  /**
   * Get performance summary
   * @returns Performance summary
   */
  getSummary(): {
    totalMetrics: number;
    slowOperations: number;
    averageDuration: number;
    topSlowest: PerformanceMetric[];
  } {
    const totalMetrics = this.metrics.length;
    const slowOperations = this.getSlowOperations().length;
    const averageDuration =
      totalMetrics > 0
        ? this.metrics.reduce((sum, m) => sum + m.duration, 0) / totalMetrics
        : 0;
    const topSlowest = [...this.metrics]
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 10);

    return {
      totalMetrics,
      slowOperations,
      averageDuration,
      topSlowest,
    };
  }
}

// Singleton instance
export const performanceMonitor = new PerformanceMonitor();

/**
 * Decorator to measure function performance
 * @param name - Metric name
 */
export function measurePerformance(name: string) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const stop = performanceMonitor.start(`${name}.${propertyKey}`);

      try {
        const result = await originalMethod.apply(this, args);
        return result;
      } finally {
        stop();
      }
    };

    return descriptor;
  };
}

/**
 * Measure async function performance
 * @param name - Metric name
 * @param fn - Function to measure
 * @returns Wrapped function
 */
export async function measureAsync<T>(
  name: string,
  fn: () => Promise<T>
): Promise<T> {
  const stop = performanceMonitor.start(name);

  try {
    return await fn();
  } finally {
    stop();
  }
}

/**
 * Measure sync function performance
 * @param name - Metric name
 * @param fn - Function to measure
 * @returns Result
 */
export function measureSync<T>(name: string, fn: () => T): T {
  const stop = performanceMonitor.start(name);

  try {
    return fn();
  } finally {
    stop();
  }
}

/**
 * Debounce function
 * @param func - Function to debounce
 * @param wait - Wait time in milliseconds
 * @returns Debounced function
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout | null = null;

  return function executedFunction(...args: Parameters<T>) {
    const later = () => {
      timeout = null;
      func(...args);
    };

    if (timeout) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(later, wait);
  };
}

/**
 * Throttle function
 * @param func - Function to throttle
 * @param limit - Time limit in milliseconds
 * @returns Throttled function
 */
export function throttle<T extends (...args: any[]) => any>(
  func: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle: boolean;

  return function executedFunction(...args: Parameters<T>) {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

/**
 * Memoize function results
 * @param func - Function to memoize
 * @returns Memoized function
 */
export function memoize<T extends (...args: any[]) => any>(
  func: T
): (...args: Parameters<T>) => ReturnType<T> {
  const cache = new Map<string, ReturnType<T>>();

  return function executedFunction(...args: Parameters<T>): ReturnType<T> {
    const key = JSON.stringify(args);

    if (cache.has(key)) {
      return cache.get(key)!;
    }

    const result = func(...args);
    cache.set(key, result);

    return result;
  };
}
