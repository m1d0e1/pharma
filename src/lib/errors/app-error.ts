/**
 * Application Error Classes
 * Standardized error handling across the application
 */

/**
 * Base application error class
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly code: string;
  public readonly details?: any;

  constructor(
    message: string,
    statusCode: number = 500,
    code: string = 'INTERNAL_ERROR',
    isOperational: boolean = true,
    details?: any
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    this.details = details;

    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * 400 Bad Request - Invalid input
 */
export class BadRequestError extends AppError {
  constructor(message: string = 'Bad Request', details?: any) {
    super(message, 400, 'BAD_REQUEST', true, details);
  }
}

/**
 * 401 Unauthorized - Authentication required
 */
export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized', details?: any) {
    super(message, 401, 'UNAUTHORIZED', true, details);
  }
}

/**
 * 403 Forbidden - Insufficient permissions
 */
export class ForbiddenError extends AppError {
  constructor(message: string = 'Forbidden', details?: any) {
    super(message, 403, 'FORBIDDEN', true, details);
  }
}

/**
 * 404 Not Found - Resource not found
 */
export class NotFoundError extends AppError {
  constructor(message: string = 'Not Found', details?: any) {
    super(message, 404, 'NOT_FOUND', true, details);
  }
}

/**
 * 409 Conflict - Resource conflict
 */
export class ConflictError extends AppError {
  constructor(message: string = 'Conflict', details?: any) {
    super(message, 409, 'CONFLICT', true, details);
  }
}

/**
 * 422 Unprocessable Entity - Validation error
 */
export class ValidationError extends AppError {
  constructor(message: string = 'Validation Error', details?: any) {
    super(message, 422, 'VALIDATION_ERROR', true, details);
  }
}

/**
 * 429 Too Many Requests - Rate limit exceeded
 */
export class RateLimitError extends AppError {
  constructor(message: string = 'Too Many Requests', details?: any) {
    super(message, 429, 'RATE_LIMIT_EXCEEDED', true, details);
  }
}

/**
 * 500 Internal Server Error - Unexpected error
 */
export class InternalServerError extends AppError {
  constructor(message: string = 'Internal Server Error', details?: any) {
    super(message, 500, 'INTERNAL_ERROR', false, details);
  }
}

/**
 * 503 Service Unavailable - Service temporarily unavailable
 */
export class ServiceUnavailableError extends AppError {
  constructor(message: string = 'Service Unavailable', details?: any) {
    super(message, 503, 'SERVICE_UNAVAILABLE', true, details);
  }
}

/**
 * Database error
 */
export class DatabaseError extends AppError {
  constructor(message: string = 'Database Error', details?: any) {
    super(message, 500, 'DATABASE_ERROR', true, details);
  }
}

/**
 * Authentication error
 */
export class AuthenticationError extends AppError {
  constructor(message: string = 'Authentication Failed', details?: any) {
    super(message, 401, 'AUTHENTICATION_ERROR', true, details);
  }
}

/**
 * Insufficient stock error
 */
export class InsufficientStockError extends AppError {
  constructor(itemId: string, requested: number, available: number) {
    super(
      `Insufficient stock for item ${itemId}. Requested: ${requested}, Available: ${available}`,
      400,
      'INSUFFICIENT_STOCK',
      true,
      { itemId, requested, available }
    );
  }
}

/**
 * Invalid token error
 */
export class InvalidTokenError extends AppError {
  constructor(message: string = 'Invalid Token', details?: any) {
    super(message, 401, 'INVALID_TOKEN', true, details);
  }
}

/**
 * Expired token error
 */
export class ExpiredTokenError extends AppError {
  constructor(message: string = 'Token Expired', details?: any) {
    super(message, 401, 'EXPIRED_TOKEN', true, details);
  }
}

/**
 * CSRF token error
 */
export class CSRFError extends AppError {
  constructor(message: string = 'Invalid CSRF Token', details?: any) {
    super(message, 403, 'CSRF_ERROR', true, details);
  }
}

/**
 * Check if an error is an operational error (expected, not a bug)
 */
export function isOperationalError(error: Error): boolean {
  if (error instanceof AppError) {
    return error.isOperational;
  }
  return false;
}

/**
 * Convert any error to an AppError
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof Error) {
    // Check for common error types
    if (error.message.includes('JWT')) {
      return new InvalidTokenError(error.message);
    }
    if (error.message.includes('expired')) {
      return new ExpiredTokenError(error.message);
    }
    if (error.message.includes('not found')) {
      return new NotFoundError(error.message);
    }
    if (error.message.includes('validation')) {
      return new ValidationError(error.message);
    }

    return new InternalServerError(error.message);
  }

  return new InternalServerError('An unexpected error occurred');
}

/**
 * Get safe error message for client (don't leak sensitive info)
 */
export function getSafeErrorMessage(error: unknown): string {
  const appError = toAppError(error);

  if (process.env.NODE_ENV === 'production') {
    // In production, only show operational errors
    if (appError.isOperational) {
      return appError.message;
    }
    return 'An error occurred. Please try again.';
  }

  // In development, show full error
  return appError.message;
}

/**
 * Get error response object
 */
export function getErrorResponse(error: unknown): {
  error: string;
  code: string;
  details?: any;
  statusCode: number;
} {
  const appError = toAppError(error);

  return {
    error: getSafeErrorMessage(error),
    code: appError.code,
    details: process.env.NODE_ENV === 'development' ? appError.details : undefined,
    statusCode: appError.statusCode
  };
}
