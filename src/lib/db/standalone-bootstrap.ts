import { validatePassword } from '@/lib/auth/password';

type BootstrapEnvironment = {
  NODE_ENV?: string;
  TAURI_BUILD?: string;
  NEXT_PUBLIC_TAURI?: string;
  PHARMA_BOOTSTRAP_OWNER_USERNAME?: string;
  PHARMA_BOOTSTRAP_OWNER_PASSWORD?: string;
  PHARMA_BOOTSTRAP_OWNER_FULL_NAME?: string;
  PHARMA_BOOTSTRAP_PHARMACY_ID?: string;
};

export type StandaloneBootstrapOwner = {
  username: string;
  password: string;
  fullName: string;
  pharmacyId: string;
};

export function isTauriBuildContext(env: BootstrapEnvironment = process.env): boolean {
  return env.TAURI_BUILD === '1' || env.NEXT_PUBLIC_TAURI === '1';
}

export function shouldRequireStandaloneBootstrap(env: BootstrapEnvironment = process.env): boolean {
  return env.NODE_ENV === 'production' && !isTauriBuildContext(env);
}

export function getStandaloneBootstrapOwner(
  env: BootstrapEnvironment = process.env,
): StandaloneBootstrapOwner | null {
  if (isTauriBuildContext(env)) return null;

  const username = env.PHARMA_BOOTSTRAP_OWNER_USERNAME?.trim() || '';
  const password = env.PHARMA_BOOTSTRAP_OWNER_PASSWORD || '';
  const fullName = env.PHARMA_BOOTSTRAP_OWNER_FULL_NAME?.trim() || 'System Owner';
  const pharmacyId = env.PHARMA_BOOTSTRAP_PHARMACY_ID?.trim() || 'local_default';

  const anyBootstrapValue = Boolean(
    username || password || env.PHARMA_BOOTSTRAP_OWNER_FULL_NAME || env.PHARMA_BOOTSTRAP_PHARMACY_ID,
  );
  if (!anyBootstrapValue) return null;

  if (!username || !password) {
    throw new Error(
      'Standalone bootstrap requires both PHARMA_BOOTSTRAP_OWNER_USERNAME and PHARMA_BOOTSTRAP_OWNER_PASSWORD.',
    );
  }
  if (username.length < 3 || username.length > 50) {
    throw new Error('PHARMA_BOOTSTRAP_OWNER_USERNAME must be between 3 and 50 characters.');
  }

  const passwordValidation = validatePassword(password);
  if (!passwordValidation.valid) {
    throw new Error(
      `PHARMA_BOOTSTRAP_OWNER_PASSWORD does not meet the password policy: ${passwordValidation.errors.join(', ')}`,
    );
  }

  return { username, password, fullName, pharmacyId };
}
