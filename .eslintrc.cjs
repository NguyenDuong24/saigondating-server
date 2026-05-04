module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  extends: ['eslint:recommended'],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'script',
  },
  rules: {
    'no-irregular-whitespace': ['error', { skipComments: true, skipStrings: true, skipTemplates: true }],
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    'unicode-bom': 'off',
  },
};
