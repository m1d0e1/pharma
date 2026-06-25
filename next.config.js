const path = require('path');

/** @type {import('next').NextConfig} */
const isTauri = process.env.TAURI_BUILD === '1';
const isTauriContext = isTauri || process.env.NEXT_PUBLIC_TAURI === '1';

const nextConfig = {
  output: isTauri ? 'export' : 'standalone',

  typescript: {
    ignoreBuildErrors: isTauri,
  },
  eslint: {
    ignoreDuringBuilds: isTauri,
  },

  serverExternalPackages: ['better-sqlite3', 'bcryptjs'],

  experimental: {
    optimizePackageImports: ['lucide-react', 'date-fns'],
  },

  poweredByHeader: false,
  compress: true,

  webpack: (config, { isServer }) => {
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


