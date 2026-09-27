import { defineConfig, globalIgnores } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier/flat';
import reactHooks from 'eslint-plugin-react-hooks';

export default defineConfig([
  globalIgnores([
    '**/node_modules/',
    '**/.next/',
    '**/dist/',
    '**/out/',
    'storage/',
    '**/next-env.d.ts',
  ]),
  js.configs.recommended,
  tseslint.configs.strict,
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [nextVitals, nextTs],
    settings: { next: { rootDir: 'apps/web/' } },
  },
  {
    // Shared React components get the same hooks rules as the app.
    files: ['packages/ui/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  prettier,
]);
