// Flat config for ESLint v9
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'node_modules/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Base config for all JS/TS files
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node, // Add all Node.js globals
      },
    },
    rules: {
      'no-console': 'off', // Assuming 'off' is desired project-wide for now
      'max-len': [
        'error',
        { code: 88, ignoreStrings: true, ignoreTemplateLiterals: true, ignoreComments: true },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Specific config for test files
  {
    files: ['tests/**/*.{js,mjs,cjs,ts}'],
    languageOptions: {
      globals: {
        ...globals.jest, // Add all Jest globals
      },
    },
    rules: {
      // In tests, using 'any' can be more pragmatic
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];


