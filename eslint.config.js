import antfu from '@antfu/eslint-config'

export default antfu({
  formatters: true,
  rules: {
    'no-console': 'off',
    'no-new-func': 'off',
    'no-case-declarations': 'off',
  },
})
