import {
  getPasswordStrength, getPasswordStrengthLabel, generateRandomPassword,
  hashPassword, passwordNeedsChange, validatePassword, verifyPassword,
} from '@/lib/auth/password';
import { getStandaloneBootstrapOwner } from '@/lib/db/standalone-bootstrap';

describe('standalone/bootstrap password helpers (not native owner enrollment)', () => {
  it.each([
    ['Sho!1A', 'at least 8'],
    ['lowercase1!', 'uppercase'],
    ['UPPERCASE1!', 'lowercase'],
    ['Uppercase!', 'number'],
    ['Uppercase1', 'special'],
  ])('rejects invalid bootstrap password %s for %s', (password, message) => {
    expect(validatePassword(password)).toMatchObject({ valid: false });
    expect(validatePassword(password).errors.join(' ')).toContain(message);
    expect(() => getStandaloneBootstrapOwner({
      PHARMA_BOOTSTRAP_OWNER_USERNAME: 'owner',
      PHARMA_BOOTSTRAP_OWNER_PASSWORD: password,
    })).toThrow('does not meet the password policy');
  });

  it('does not leak a candidate password in the bcrypt hash or accept a wrong candidate', async () => {
    const cleartext = 'Correct!Horse2026';
    expect(validatePassword(cleartext)).toEqual({ valid: true, errors: [] });
    const digest = await hashPassword(cleartext);
    expect(digest).toMatch(/^\$2[aby]\$12\$/);
    expect(digest).not.toContain(cleartext);
    await expect(verifyPassword(cleartext, digest)).resolves.toBe(true);
    await expect(verifyPassword('Incorrect!Horse2026', digest)).resolves.toBe(false);
    await expect(hashPassword('weak')).rejects.toThrow();
  });

  it('generates strong passwords with the requested length and four character classes', () => {
    for (const length of [8, 16, 32]) {
      const generated = generateRandomPassword(length);
      expect(generated).toHaveLength(length);
      expect(validatePassword(generated)).toEqual({ valid: true, errors: [] });
    }
  });

  it('interprets expiry threshold and password-strength labels', () => {
    const now = Date.now();
    expect(passwordNeedsChange(new Date(now - 91 * 86_400_000))).toBe(true);
    expect(passwordNeedsChange(new Date(now - 10 * 86_400_000))).toBe(false);
    expect(passwordNeedsChange(new Date(now - 15 * 86_400_000), 14)).toBe(true);
    expect(getPasswordStrength('')).toBe(0);
    expect(getPasswordStrengthLabel('')).toBe('Very Weak');
    expect(getPasswordStrengthLabel('abc')).toBe('Weak');
    expect(getPasswordStrength('S3cure!Horse2026')).toBe(4);
    expect(getPasswordStrengthLabel('S3cure!Horse2026')).toBe('Very Strong');
  });
});
