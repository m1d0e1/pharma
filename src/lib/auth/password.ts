import bcrypt from 'bcryptjs';
import { z } from 'zod';
import crypto from 'crypto';

// Password validation schema
export const PasswordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character');

export type Password = z.infer<typeof PasswordSchema>;

// Bcrypt cost factor (higher is more secure but slower)
const BCRYPT_COST = 12;

/**
 * Hash a password using bcrypt
 * @param password - Plain text password
 * @returns Hashed password
 */
export async function hashPassword(password: string): Promise<string> {
  // Validate password before hashing
  PasswordSchema.parse(password);

  return bcrypt.hash(password, BCRYPT_COST);
}

/**
 * Verify a password against a hash
 * @param password - Plain text password
 * @param hash - Hashed password
 * @returns True if password matches hash
 */
export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Validate password strength
 * @param password - Plain text password
 * @returns Validation result
 */
export function validatePassword(password: string): {
  valid: boolean;
  errors: string[];
} {
  const result = PasswordSchema.safeParse(password);

  if (result.success) {
    return { valid: true, errors: [] };
  }

  return {
    valid: false,
    errors: result.error.issues.map((e) => e.message),
  };
}

/**
 * Generate a random password
 * @param length - Password length (default 16)
 * @returns Random password
 */
export function generateRandomPassword(length: number = 16): string {
  const charset =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  const getRandomInt = (max: number) => crypto.getRandomValues(new Uint32Array(1))[0] % max;

  let password = '';
  password += charset[getRandomInt(26)]; // Uppercase
  password += charset[26 + getRandomInt(26)]; // Lowercase
  password += charset[52 + getRandomInt(10)]; // Number
  password += charset[62 + getRandomInt(8)]; // Special

  for (let i = password.length; i < length; i++) {
    password += charset[getRandomInt(charset.length)];
  }

  const arr = password.split('');
  for (let i = arr.length - 1; i > 0; i--) {
    const j = getRandomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join('');
}

/**
 * Check if password needs to be changed (e.g., expired or compromised)
 * @param lastChanged - Date when password was last changed
 * @param maxAge - Maximum password age in days (default 90)
 * @returns True if password needs to be changed
 */
export function passwordNeedsChange(
  lastChanged: Date,
  maxAge: number = 90
): boolean {
  const now = new Date();
  const ageInDays =
    (now.getTime() - lastChanged.getTime()) / (1000 * 60 * 60 * 24);
  return ageInDays > maxAge;
}

/**
 * Get password strength score
 * @param password - Plain text password
 * @returns Strength score (0-4)
 */
export function getPasswordStrength(password: string): number {
  let score = 0;

  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[a-z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  return Math.min(score, 4);
}

/**
 * Get password strength label
 * @param password - Plain text password
 * @returns Strength label
 */
export function getPasswordStrengthLabel(password: string): string {
  const strength = getPasswordStrength(password);
  const labels = ['Very Weak', 'Weak', 'Fair', 'Strong', 'Very Strong'];
  return labels[strength];
}
