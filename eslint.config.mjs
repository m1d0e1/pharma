import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'

export default defineConfig([
  ...nextVitals,
  globalIgnores([
    '.agents/**',
    '.next/**',
    'coverage/**',
    'out/**',
    'src-tauri/gen/**',
    'src-tauri/target/**',
    'next-env.d.ts',
  ]),
  {
    // Next 15 does not use the React Compiler rules enabled by eslint-config-next 16.
    rules: {
      'react-hooks/immutability': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/static-components': 'off',
    },
  },
])
