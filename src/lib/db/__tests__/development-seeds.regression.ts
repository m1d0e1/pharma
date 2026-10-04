jest.mock('@/scripts/importInteractions', () => ({ importInteractionsFromCSV: jest.fn() }));

describe('standalone development user seeds', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSeedFlag = process.env.PHARMA_ENABLE_INSECURE_DEV_SEEDS;
  const originalTauriBuild = process.env.TAURI_BUILD;
  const originalPublicTauri = process.env.NEXT_PUBLIC_TAURI;
  const originalBootstrapUsername = process.env.PHARMA_BOOTSTRAP_OWNER_USERNAME;
  const originalBootstrapPassword = process.env.PHARMA_BOOTSTRAP_OWNER_PASSWORD;
  const originalBootstrapFullName = process.env.PHARMA_BOOTSTRAP_OWNER_FULL_NAME;
  const originalBootstrapPharmacyId = process.env.PHARMA_BOOTSTRAP_PHARMACY_ID;

  const restoreEnvironment = () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
    if (originalSeedFlag === undefined) delete process.env.PHARMA_ENABLE_INSECURE_DEV_SEEDS;
    else process.env.PHARMA_ENABLE_INSECURE_DEV_SEEDS = originalSeedFlag;
    if (originalTauriBuild === undefined) delete process.env.TAURI_BUILD;
    else process.env.TAURI_BUILD = originalTauriBuild;
    if (originalPublicTauri === undefined) delete process.env.NEXT_PUBLIC_TAURI;
    else process.env.NEXT_PUBLIC_TAURI = originalPublicTauri;
    if (originalBootstrapUsername === undefined) delete process.env.PHARMA_BOOTSTRAP_OWNER_USERNAME;
    else process.env.PHARMA_BOOTSTRAP_OWNER_USERNAME = originalBootstrapUsername;
    if (originalBootstrapPassword === undefined) delete process.env.PHARMA_BOOTSTRAP_OWNER_PASSWORD;
    else process.env.PHARMA_BOOTSTRAP_OWNER_PASSWORD = originalBootstrapPassword;
    if (originalBootstrapFullName === undefined) delete process.env.PHARMA_BOOTSTRAP_OWNER_FULL_NAME;
    else process.env.PHARMA_BOOTSTRAP_OWNER_FULL_NAME = originalBootstrapFullName;
    if (originalBootstrapPharmacyId === undefined) delete process.env.PHARMA_BOOTSTRAP_PHARMACY_ID;
    else process.env.PHARMA_BOOTSTRAP_PHARMACY_ID = originalBootstrapPharmacyId;
    delete process.env.PHARMA_DB_PATH;
    delete (global as any).__db_initialized;
  };

  afterEach(() => {
    try {
      const { closeDatabase } = require('../client');
      closeDatabase();
    } catch {}
    restoreEnvironment();
    jest.resetModules();
  });

  function bootstrap(nodeEnv: string, seedFlag?: string, tauri = false) {
    process.env.PHARMA_DB_PATH = ':memory:';
    (process.env as Record<string, string | undefined>).NODE_ENV = nodeEnv;
    if (seedFlag === undefined) delete process.env.PHARMA_ENABLE_INSECURE_DEV_SEEDS;
    else process.env.PHARMA_ENABLE_INSECURE_DEV_SEEDS = seedFlag;
    delete process.env.TAURI_BUILD;
    delete process.env.NEXT_PUBLIC_TAURI;
    if (tauri) process.env.NEXT_PUBLIC_TAURI = '1';
    delete (global as any).__db_initialized;
    jest.resetModules();
    return require('../client').getDatabase();
  }

  it('does not create known admin or test credentials by default', () => {
    const db = bootstrap('development');

    expect(db.prepare("SELECT id FROM users WHERE username = 'admin' OR id = 'TEST_USER'").all()).toEqual([]);
  });

  it('allows the legacy development seeds only with explicit development opt-in', () => {
    const db = bootstrap('development', '1');

    expect(db.prepare("SELECT id, username, role, is_active FROM users WHERE username = 'admin' OR id = 'TEST_USER' ORDER BY id").all()).toEqual([
      { id: 'TEST_USER', username: 'test_user', role: 'pharmacist', is_active: 0 },
      { id: 'admin', username: 'admin', role: 'owner', is_active: 1 },
    ]);
  });

  it('ignores the insecure opt-in for packaged Tauri production', () => {
    const db = bootstrap('production', '1', true);

    expect(db.prepare("SELECT id FROM users WHERE username = 'admin' OR id = 'TEST_USER'").all()).toEqual([]);
  });

  it('requires explicit first-owner configuration for an empty production standalone database', () => {
    expect(() => bootstrap('production')).toThrow(/PHARMA_BOOTSTRAP_OWNER_USERNAME/);
  });

  it('creates one secure owner from explicit production standalone bootstrap configuration', () => {
    process.env.PHARMA_BOOTSTRAP_OWNER_USERNAME = 'first_owner';
    process.env.PHARMA_BOOTSTRAP_OWNER_PASSWORD = 'Strong!Pass123';
    process.env.PHARMA_BOOTSTRAP_OWNER_FULL_NAME = 'First Owner';
    process.env.PHARMA_BOOTSTRAP_PHARMACY_ID = 'ph-bootstrap';

    const db = bootstrap('production');
    const owner = db.prepare(`
      SELECT id, username, password_hash, role, full_name, pharmacy_id, is_active
      FROM users
    `).get() as any;

    expect(owner).toMatchObject({
      id: 'bootstrap-owner',
      username: 'first_owner',
      role: 'owner',
      full_name: 'First Owner',
      pharmacy_id: 'ph-bootstrap',
      is_active: 1,
    });
    expect(owner.password_hash).not.toBe('Strong!Pass123');
    expect(require('bcryptjs').compareSync('Strong!Pass123', owner.password_hash)).toBe(true);
  });
});
