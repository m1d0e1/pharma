/**
 * Error Handler Middleware
 * Standardized error handling for API routes
 */

import { NextResponse, NextRequest } from 'next/server';
import {
  AppError,
  toAppError,
  getSafeErrorMessage,
  getErrorResponse
} from './app-error';

/**
 * Wrap an async handler with error handling
 * @param handler - The async handler to wrap
 * @returns Wrapped handler with error handling
 */
export function withErrorHandler<T extends NextRequest>(
  handler: (request: T) => Promise<NextResponse>
): (request: T) => Promise<NextResponse> {
  return async (request: T) => {
    try {
      return await handler(request);
    } catch (error) {
      return handleApiError(error);
    }
  };
}

/**
 * Handle API errors and return appropriate response
 * @param error - The error to handle
 * @returns NextResponse with error details
 */
export function handleApiError(error: unknown): NextResponse {
  const appError = toAppError(error);

  // Log the error
  console.error('API Error:', {
    name: appError.name,
    message: appError.message,
    code: appError.code,
    statusCode: appError.statusCode,
    details: appError.details,
    stack: process.env.NODE_ENV === 'development' ? appError.stack : undefined
  });

  // Return error response
  const response = NextResponse.json(
    {
      error: getSafeErrorMessage(error),
      code: appError.code,
      ...(process.env.NODE_ENV === 'development' && { details: appError.details })
    },
    { status: appError.statusCode }
  );

  // Add security headers
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');

  return response;
}

/**
 * Create a standardized success response
 * @param data - The data to return
 * @param status - HTTP status code (default 200)
 * @returns NextResponse with data
 */
export function successResponse<T>(
  data: T,
  status: number = 200
): NextResponse<{ success: true; data: T }> {
  const response = NextResponse.json<{ success: true; data: T }>(
    { success: true, data },
    { status }
  );

  // Add security headers
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');

  return response;
}

/**
 * Create a standardized error response
 * @param message - Error message
 * @param code - Error code
 * @param status - HTTP status code (default 400)
 * @param details - Additional error details
 * @returns NextResponse with error
 */
export function errorResponse(
  message: string,
  code: string = 'ERROR',
  status: number = 400,
  details?: any
): NextResponse<{ success: false; error: string; code: string; details?: any }> {
  const response = NextResponse.json<{ success: false; error: string; code: string; details?: any }>(
    { success: false, error: message, code, details },
    { status }
  );

  // Add security headers
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');

  return response;
}

/**
 * Validate request body with Zod schema
 * @param schema - Zod schema to validate against
 * @param data - Data to validate
 * @returns Validated data or throws ValidationError
 */
export async function validateRequest<T>(
  schema: { parse: (data: unknown) => T },
  data: unknown
): Promise<T> {
  try {
    return schema.parse(data);
  } catch (error) {
    if (error && typeof error === 'object' && 'errors' in error) {
      throw errorResponse(
        'Validation failed',
        'VALIDATION_ERROR',
        422,
        { errors: (error as any).errors }
      );
    }
    throw errorResponse('Validation failed', 'VALIDATION_ERROR', 422);
  }
}

/**
 * Wrap a handler with permission check
 * @param handler - The handler to wrap
 * @param requiredPermissions - Required permissions
 * @returns Wrapped handler with permission check
 */
export function withPermissions<T extends NextRequest>(
  handler: (request: T) => Promise<NextResponse>,
  requiredPermissions: string[]
): (request: T) => Promise<NextResponse> {
  return withErrorHandler(async (request: T) => {
    // Get user from request (implement based on your auth system)
    const user = (request as any).user;

    if (!user) {
      return errorResponse('Unauthorized', 'UNAUTHORIZED', 401);
    }

    // Check permissions
    const userPermissions = user.permissions || [];
    const hasPermission = requiredPermissions.every(perm =>
      userPermissions.includes(perm)
    );

    if (!hasPermission) {
      return errorResponse('Forbidden', 'FORBIDDEN', 403);
    }

    return handler(request);
  });
}

/**
 * Wrap a handler with authentication check
 * @param handler - The handler to wrap
 * @returns Wrapped handler with authentication check
 */
export function withAuth<T extends NextRequest>(
  handler: (request: T) => Promise<NextResponse>
): (request: T) => Promise<NextResponse> {
  return withErrorHandler(async (request: T) => {
    // Get user from request (implement based on your auth system)
    const user = (request as any).user;

    if (!user) {
      return errorResponse('Unauthorized', 'UNAUTHORIZED', 401);
    }

    return handler(request);
  });
}
