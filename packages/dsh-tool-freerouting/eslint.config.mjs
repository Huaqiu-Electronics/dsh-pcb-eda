import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['lib/**', 'dist/**', 'python/**', 'bundled/**', '.dsh-host-smoke/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      curly: ['error', 'all'],
      'brace-style': ['error', '1tbs', { allowSingleLine: false }],
      'no-inline-comments': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ForStatement[test=null]',
          message: 'Use while (true) with explicit timeout/cancellation and terminal-state exits.',
        },
        {
          selector: 'CallExpression[callee.type="ArrowFunctionExpression"][callee.async=true]',
          message: 'Use a named async operation instead of an async IIFE.',
        },
        {
          selector: 'CallExpression[callee.type="FunctionExpression"][callee.async=true]',
          message: 'Use a named async operation instead of an async IIFE.',
        },
      ],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },
);
