/**
 * Configuration for Playwright using default from @jupyterlab/galata
 *
 * The kernel must be installed in the pixi environment first: pixi run install
 */
const baseConfig = require('@jupyterlab/galata/lib/playwright-config');

module.exports = {
  ...baseConfig,
  // The JupyterLite tests in lite/ have their own configuration
  testDir: './tests',
  // The kernel runs one cell at a time: keep the tests sequential
  workers: 1,
  webServer: {
    command: 'jupyter lab --config jupyter_server_test_config.py',
    url: 'http://localhost:8888/lab',
    timeout: 120 * 1000,
    reuseExistingServer: !process.env.CI,
    // Let the server shut down its kernels: they do not stop with it
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10 * 1000 }
  }
};
