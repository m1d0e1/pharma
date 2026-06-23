import * as fs from 'fs';
import * as path from 'path';

describe('Tauri Configuration', () => {
  const configPath = path.resolve(__dirname, '../../src-tauri/tauri.conf.json');
  let config: any;

  beforeAll(() => {
    const raw = fs.readFileSync(configPath, 'utf-8');
    config = JSON.parse(raw);
  });

  it('has a valid identifier format', () => {
    expect(config.identifier).toMatch(/^com\.\w+\.\w+$/);
  });

  it('has a valid version string', () => {
    expect(config.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('frontendDist points to the correct export directory', () => {
    expect(config.build.frontendDist).toBe('../out');
  });

  it('devUrl points to localhost:3000', () => {
    expect(config.build.devUrl).toBe('http://localhost:3000');
  });

  it('sets withGlobalTauri for frontend IPC access', () => {
    expect(config.app.withGlobalTauri).toBe(true);
  });

  it('CSP is not null', () => {
    expect(config.app.security.csp).toBeTruthy();
    expect(typeof config.app.security.csp).toBe('string');
  });

  it('CSP restricts frame ancestors', () => {
    expect(config.app.security.csp).toContain('frame-ancestors');
    expect(config.app.security.csp).toContain('base-uri');
    expect(config.app.security.csp).toContain('form-action');
  });

  it('CSP restricts connect-src', () => {
    expect(config.app.security.csp).toContain('connect-src');
    expect(config.app.security.csp).toContain("'self'");
  });

  it('window is configured with correct size and maximized', () => {
    const win = config.app.windows[0];
    expect(win.width).toBe(1280);
    expect(win.height).toBe(800);
    expect(win.maximized).toBe(true);
    expect(win.resizable).toBe(true);
  });

  it('has updater configured', () => {
    expect(config.plugins.updater).toBeDefined();
    expect(config.plugins.updater.endpoints).toBeDefined();
    expect(config.plugins.updater.endpoints[0]).toContain('github.com');
    expect(config.plugins.updater.pubkey).toBeDefined();
  });

  it('SQL plugin is configured with sqlite', () => {
    expect(config.plugins.sql).toBeDefined();
    expect(config.plugins.sql.sqlite).toBeDefined();
    expect(config.plugins.sql.sqlite).toContain('sqlite:pharma_local.db');
  });

  it('bundle includes the seeded database', () => {
    expect(config.bundle.resources).toContain('pharma_local.db');
  });

  it('bundle has all required icons', () => {
    const icons = config.bundle.icon;
    expect(icons).toContain('icons/32x32.png');
    expect(icons).toContain('icons/128x128.png');
    expect(icons).toContain('icons/icon.icns');
    expect(icons).toContain('icons/icon.ico');
  });
});
