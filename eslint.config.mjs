import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      // Prevent emojis in code
      'no-irregular-whitespace': ['error', {
        skipStrings: false,
        skipComments: false,
        skipRegExps: false,
        skipTemplates: false,
      }],
    },
  },
  {
    plugins: {
      'custom-rules': {
        rules: {
          'no-emoji': {
            meta: {
              type: 'problem',
              docs: {
                description: 'Disallow emoji characters in code',
                category: 'Best Practices',
              },
              messages: {
                noEmoji: 'Emojis are not allowed. Use text alternatives (WARNING:, ERROR:, INFO:, etc.)',
              },
            },
            create(context) {
              const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{27BF}\u{2700}-\u{27BF}\u2705\u2714\u274C\u26A0\u2139]/u;

              return {
                Program(node) {
                  const sourceCode = context.sourceCode || context.getSourceCode();
                  const text = sourceCode.getText();

                  if (emojiRegex.test(text)) {
                    context.report({
                      node,
                      messageId: 'noEmoji',
                    });
                  }
                },
              };
            },
          },
        },
      },
    },
    rules: {
      'custom-rules/no-emoji': 'error',
    },
  },
);