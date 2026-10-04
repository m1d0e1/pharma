export function shouldSeedInsecureDevelopmentUsers(
  env: { NODE_ENV?: string; PHARMA_ENABLE_INSECURE_DEV_SEEDS?: string } = process.env,
): boolean {
  return env.NODE_ENV === 'development' && env.PHARMA_ENABLE_INSECURE_DEV_SEEDS === '1';
}
