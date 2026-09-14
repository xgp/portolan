import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * SPEC.md §58 requires a one-way dependency graph:
 *   mcp -> services -> catalog/search/execution -> storage/net/sandbox
 * The `no-restricted-imports` rules below enforce the important half of that
 * (nothing below the MCP layer may import the MCP layer) mechanically.
 */
const noMcpImports = {
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: ['**/mcp/**', '../mcp/*', '../../mcp/*'],
          message:
            'SPEC.md §58: catalog, search, execution and sandbox must not depend on the MCP layer.',
        },
      ],
    },
  ],
};

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'src/sandbox/runtime.js', '**/*.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    files: [
      'src/catalog/**/*.ts',
      'src/search/**/*.ts',
      'src/execution/**/*.ts',
      'src/sandbox/**/*.ts',
      'src/openapi/**/*.ts',
      'src/storage/**/*.ts',
      'src/net/**/*.ts',
    ],
    rules: noMcpImports,
  },
  {
    files: ['src/cli/**/*.ts', 'scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  prettier,
);
