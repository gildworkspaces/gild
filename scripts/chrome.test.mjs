import assert from 'node:assert/strict'
import { test } from 'node:test'
import { launchChrome } from './chrome.mjs'

test('CHROME_PATH controls the actual browser process; an explicit path wins', async () => {
  const original = process.env.CHROME_PATH
  const missing = new URL('../.tmp/missing-chrome', import.meta.url).pathname
  try {
    // A launcher that ignores CHROME_PATH would launch installed Chrome and
    // fail this assertion. Close that unexpected process in the revert proof.
    process.env.CHROME_PATH = missing
    await assert.rejects(async () => {
      const browser = await launchChrome()
      await browser.close()
    }, /executable doesn't exist/)

    // Exercise a real browser, including a path containing spaces on macOS.
    if (original) {
      const browser = await launchChrome({ executablePath: original })
      try {
        const page = await browser.newPage()
        await page.setContent('<title>CI Chrome</title>')
        assert.equal(await page.title(), 'CI Chrome')
      } finally {
        await browser.close()
      }
    }
  } finally {
    if (original === undefined) delete process.env.CHROME_PATH
    else process.env.CHROME_PATH = original
  }
})
