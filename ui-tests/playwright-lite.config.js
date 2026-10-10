/**
 * Configuration for Playwright to test the JupyterLite site
 *
 * The site is built in ../_output with: pixi run -e wasm-build lite-build
 */
module.exports = {
  testDir: './lite',
  testMatch: '*.spec.ts',
  timeout: 120 * 1000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:8000/',
    browserName: 'chromium',
    viewport: { width: 1280, height: 800 },
    video: 'retain-on-failure',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'python -m http.server 8000 --directory ../_output',
    url: 'http://localhost:8000/lab/index.html',
    timeout: 60 * 1000,
    reuseExistingServer: !process.env.CI
  }
};
