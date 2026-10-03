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
  {
    // Write options that skip the sensitive-field guard or the database validator
    // (docs/adr/0012-fail-closed-sensitive-fields.md, SECURITY.md#sensitive-data). Only object
    // literal keys are matched, so reading an option (`options.middleware`) or a TypeScript type
    // is not flagged. A computed key or a connection under another name isn't caught: review it.
    files: ['apps/**/*.{ts,tsx,js,mjs}', 'packages/**/*.{ts,tsx,js,mjs}', 'scripts/**/*.{ts,mjs}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...['middleware', 'bypassDocumentValidation'].flatMap((key) =>
          [
            `ObjectExpression > Property[key.name='${key}']`,
            `ObjectExpression > Property[key.value='${key}']`,
          ].map((selector) => ({
            selector,
            message: `The option "${key}" skips the sensitive-field guard or the database validator, and can store plain text or lose a value. Never pass it (ADR 0012, docs/adr/0012-fail-closed-sensitive-fields.md).`,
          })),
        ),
        {
          selector:
            "CallExpression[callee.property.name='bulkWrite']:matches([callee.object.property.name=/^(connection|db)$/], [callee.object.name=/^(connection|conn|db)$/])",
          message:
            "Connection.bulkWrite never runs the models' bulkWrite hooks, so it skips the sensitive-field guard. Use Model.bulkWrite (ADR 0012, docs/adr/0012-fail-closed-sensitive-fields.md).",
        },
      ],
    },
  },
  {
    // The guard's tests use these options on purpose, to show what is refused and the known limits.
    files: ['packages/core/src/server/encryption/guard.test.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  prettier,
]);
