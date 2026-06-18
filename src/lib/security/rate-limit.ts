/**
 * Rate Limiting Utility
 * Provides in-memory rate limiting for API endpoints
 * For production, consider using Redis for distributed rate limiting
 */

interface RateLimitRecord {
  count: number;
  resetTime: number;
}

// In-memory store (for single-instance deployments)
const rateLimitStore = new Map<string, RateLimitRecord>();

// Cleanup interval to remove old records
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of rateLimitStore.entries()) {
    if (now > record.resetTime) {
      rateLimitStore.delete(key);
    }
  }
}, 60 * 1000); // Cleanup every minute

/**
 * Check if a request should be rate limited
 * @param identifier - Unique identifier (IP address, user ID, etc.)
 * @param maxRequests - Maximum number of requests allowed
 * @param windowMs - Time window in milliseconds
 * @returns Rate limit result
 */
export async function rateLimit(
  identifier: string,
  maxRequests: number = 100,
  windowMs: number = 60 * 1000
): Promise<{
  success: boolean;
  remaining: number;
  resetTime: number;
  retryAfter?: number;
}> {
  const now = Date.now();
  const record = rateLimitStore.get(identifier);

  // No existing record or expired
  if (!record || now > record.resetTime) {
    const resetTime = now + windowMs;
    rateLimitStore.set(identifier, {
      count: 1,
      resetTime
    });
    return {
      success: true,
      remaining: maxRequests - 1,
      resetTime
    };
  }

  // Check if limit exceeded
  if (record.count >= maxRequests) {
    const retryAfter = Math.ceil((record.resetTime - now) / 1000);
    return {
      success: false,
      remaining: 0,
      resetTime: record.resetTime,
      retryAfter
    };
  }

  // Increment count
  record.count++;
  return {
    success: true,
    remaining: maxRequests - record.count,
    resetTime: record.resetTime
  };
}

/**
 * Get rate limit headers for response
 * @param result - Rate limit result
 * @returns Headers object
 */
export function getRateLimitHeaders(result: {
  success: boolean;
  remaining: number;
  resetTime: number;
  retryAfter?: number;
}): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Remaining': result.remaining.toString(),
    'X-RateLimit-Reset': new Date(result.resetTime).toISOString()
  };

  if (!result.success && result.retryAfter) {
    headers['Retry-After'] = result.retryAfter.toString();
  }

  return headers;
}

/**
 * Clear rate limit for a specific identifier
 * @param identifier - Unique identifier
 */
export function clearRateLimit(identifier: string): void {
  rateLimitStore.delete(identifier);
}

/**
 * Get current rate limit status for an identifier
 * @param identifier - Unique identifier
 * @returns Current rate limit status or null
 */
export function getRateLimitStatus(identifier: string): {
  count: number;
  resetTime: number;
  remaining: number;
} | null {
  const record = rateLimitStore.get(identifier);
  if (!record || Date.now() > record.resetTime) {
    return null;
  }
  return {
    count: record.count,
    resetTime: record.resetTime,
    remaining: Math.max(0, 100 - record.count) // Default max of 100
  };
}
