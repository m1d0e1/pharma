const path = require('path');

/** @type {import('next').NextConfig} */
const isTauri = process.env.TAURI_BUILD === '1';

const nextConfig = {
  output: isTauri ? 'export' : 'standalone',

  // In Tauri mode: suppress TS/lint errors since we alias server actions → client actions
  // and the original server action files are still present (only aliased away by webpack)
  typescript: {
    ignoreBuildErrors: isTauri,
  },
  eslint: {
    ignoreDuringBuilds: isTauri,
  },

  // Keep native modules server-side only (prevents bundling issues & speeds up cold start)
  serverExternalPackages: ['better-sqlite3', 'bcryptjs'],

  // Optimize lucide-react imports — tree-shakes icons and reduces JS bundle significantly
  experimental: {
    optimizePackageImports: ['lucide-react', 'date-fns'],
  },

  // Disable X-Powered-By header (minor security + perf)
  poweredByHeader: false,

  // Compress responses
  compress: true,

  webpack: (config, { isServer }) => {
    // Apply Tauri-specific aliases for both production builds (TAURI_BUILD=1)
    // AND dev mode (NEXT_PUBLIC_TAURI=1, set in .env.local or tauri:dev script)
    const isTauriBuild = process.env.TAURI_BUILD === '1';
    const isTauriDev = process.env.NEXT_PUBLIC_TAURI === '1';
    if (isTauriBuild || isTauriDev) {
      config.resolve.alias = {
        ...config.resolve.alias,
        '@/app/actions': path.resolve(__dirname, 'src/app/actions-client'),
        '@/utils/supabase/server': path.resolve(__dirname, 'src/utils/supabase/client'),
        [path.resolve(__dirname, 'src/utils/supabase/server')]: path.resolve(__dirname, 'src/utils/supabase/client'),
        [path.resolve(__dirname, 'src/utils/supabase/server.ts')]: path.resolve(__dirname, 'src/utils/supabase/client.ts'),
      };
    }
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        os: false,
        crypto: false,
      };
      config.externals = [...(config.externals || []), 'better-sqlite3'];
    }
    return config;
  },

  ...(isTauri ? {
    images: {
      unoptimized: true,
    },
  } : {}),
};

module.exports = nextConfig;


