import { chromium } from 'playwright-core'

// CI selects the preinstalled binary on Linux/macOS. Local runs can keep using
// Playwright's Chrome channel; explicit callers (nav --chrome) take precedence.
export function launchChrome(options = {}) {
  const executablePath = options.executablePath || process.env.CHROME_PATH
  return chromium.launch({
    headless: true,
    ...options,
    ...(executablePath ? { executablePath } : { channel: 'chrome' }),
  })
}
