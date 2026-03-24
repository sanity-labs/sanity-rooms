import { defineConfig } from '@sanity/pkg-utils'

export default defineConfig({
  tsconfig: 'tsconfig.build.json',
  extract: {
    checkTypes: false,
    rules: {
      'ae-missing-release-tag': 'off',
    },
  },
})
