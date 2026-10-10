/**
 * Configuration for Playwright to record the screencast of JupyterLite
 *
 * The site is built in ../_output with: pixi run -e wasm-build lite-build
 */
const baseConfig = require('./playwright-lite.config');

const scale = 2;

module.exports = {
  ...baseConfig,
  testMatch: '*.screencast.ts',
  outputDir: './screencast-results/test-output',
  timeout: 4 * 60 * 1000,
  use: {
    ...baseConfig.use,
    // Without it, the screencast frames are captured at the viewport size,
    // whatever the device scale factor.
    launchOptions: { args: [`--force-device-scale-factor=${scale}`] },
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: scale,
    trace: 'off',
    video: 'off'
  }
};
