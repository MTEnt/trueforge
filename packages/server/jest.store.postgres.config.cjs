/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testEnvironmentOptions: {
    // Resolve @truefoundry/utils-core via package.json exports (one source of truth), not moduleNameMapper.
    // "development" → src matches host-dev; mappers would duplicate that and drift (incl. bare entrypoints).
    // Jest replaces default conditions — keep node/node-addons so other packages still resolve.
    customExportConditions: ['development', 'node', 'node-addons'],
  },
  globalSetup: '<rootDir>/tests/db/postgres/globalSetup.ts',
  transform: {
    '^.+\\.(m?js|tsx?)$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript', decorators: true, dynamicImport: true },
          target: 'es2022',
        },
        module: { type: 'commonjs' },
      },
    ],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transformIgnorePatterns: ['/node_modules/(?!.*kysely)'],
  testTimeout: 120_000,
  maxWorkers: '50%',
  roots: ['<rootDir>/tests/db', '<rootDir>/src'],
  testMatch: ['<rootDir>/tests/db/**/postgres/**/*.test.ts'],
};
