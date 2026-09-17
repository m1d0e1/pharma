import fs from 'fs';
import path from 'path';

describe('offline public Supabase client', () => {
  it('does not persist or refresh cloud authentication', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src', 'lib', 'supabase.ts'),
      'utf8'
    );

    expect(source).toContain('persistSession: false');
    expect(source).toContain('autoRefreshToken: false');
    expect(source).toContain('detectSessionInUrl: false');
    expect(source).not.toContain("from '@/lib/env'");
  });

  it('keeps product authentication local and leaves Supabase for public data only', () => {
    const files = [
      ['src', 'app', '(dashboard)', 'layout.tsx'],
      ['src', 'app', 'actions-client', 'auth.ts'],
      ['src', 'app', 'actions-client', 'settings.ts'],
      ['src', 'app', 'auth', 'signout', 'route.ts'],
      ['src', 'middleware.ts'],
    ];
    const combined = files
      .map(parts => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8'))
      .join('\n');

    expect(combined).not.toMatch(/supabase\.auth|loginCloudAction|from\(['"]profiles['"]\)/);
  });
});
