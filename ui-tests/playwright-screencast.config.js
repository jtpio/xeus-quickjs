/**
 * Configuration for Playwright to record the screencasts of the features
 *
 * The videos are written in screencast-results/, ffmpeg must be on the PATH.
 */
const baseConfig = require('./playwright.config');

const scale = 2;

module.exports = {
  ...baseConfig,
  testDir: './screencast',
  testMatch: '*.screencast.ts',
  outputDir: './screencast-results/test-output',
  reporter: 'list',
  retries: 0,
  timeout: 4 * 60 * 1000,
  workers: 1,
  use: {
    ...baseConfig.use,
    browserName: 'chromium',
    // Without it, the screencast frames are captured at the viewport size,
    // whatever the device scale factor.
    launchOptions: { args: [`--force-device-scale-factor=${scale}`] },
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: scale,
    trace: 'off',
    video: 'off'
  }
};
