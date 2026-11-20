const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:3300', viewport: { width: 1440, height: 1000 } },
  webServer: {
    command: 'go run .',
    url: 'http://127.0.0.1:3300/healthz',
    reuseExistingServer: false,
    env: { SNMP_TARGET: '127.0.0.1', SNMP_COMMUNITY: 'browser-test', PORT: '3300', SNMP_TIMEOUT: '100ms', SNMP_RETRIES: '0' },
  },
});
