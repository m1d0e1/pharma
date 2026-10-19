import fs from 'fs';
import path from 'path';

describe('desktop-only cloud boundary', () => {
  it('removes automated GitHub backups and keeps local database backups available', () => {
    const root = process.cwd();
    expect(fs.existsSync(path.join(root, '.github', 'workflows', 'database-backup.yml'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'scripts', 'backup-database.js'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'src-tauri', 'src', 'database_backup.rs'))).toBe(true);
  });

  it('bundles announcements locally and does not ship a Supabase auth server client', () => {
    const root = process.cwd();
    const news = JSON.parse(fs.readFileSync(path.join(root, 'public', 'news.json'), 'utf8'));
    expect(news).toEqual(expect.arrayContaining([expect.objectContaining({ id: expect.any(String) })]));
    expect(fs.readFileSync(path.join(root, 'src', 'components', 'dashboard', 'NewsBar.tsx'), 'utf8'))
      .toContain("const NEWS_URL = '/news.json'");
    expect(fs.existsSync(path.join(root, 'src', 'utils', 'supabase', 'server.ts'))).toBe(false);
  });

  it('retains the first-install local owner seed', () => {
    const migration = fs.readFileSync(path.join(process.cwd(), 'src-tauri', 'migrations', '001_initial.sql'), 'utf8');
    expect(migration).toMatch(/INSERT OR IGNORE INTO users/);
    expect(migration).toMatch(/'admin'[\s\S]*'admin'[\s\S]*'owner'/);
  });
});
