import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { realpathSync } from 'node:fs'

const { chromium } = createRequire(import.meta.url)('playwright')

export async function connectDevelopmentRenderer(endpoint, connections) {
  assert.equal(new URL(endpoint).hostname, '127.0.0.1', 'Only a local CDP endpoint is allowed.')
  assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1', 'Run checks with ORCA_BACKGROUND_LAUNCH=1.')
  let lastError
  for (let attempt = 0; attempt < 60; attempt++) {
    let browser
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: 1000 })
      const page = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url() === 'http://127.0.0.1:5174/web-index.html')
      assert.ok(page, 'No Tauri development renderer was found.')
      connections.add(browser)
      return page
    } catch (error) {
      lastError = error
      await browser?.close()
      await delay(250)
    }
  }
  throw lastError
}

export async function assertReadyHidden(page, root) {
  await page.waitForFunction(
    () => Boolean(window.api?.app) && document.body.innerText.length > 20,
    null,
    { timeout: 30000 }
  )
  const snapshot = await page.evaluate(async () => ({
    identity: await window.api.app.getIdentity(),
    runtime: await window.__TAURI_INTERNALS__.invoke('poc_runtime_status'),
    visible: await window.__TAURI__.window.getCurrentWindow().isVisible()
  }))
  assert.equal(
    realpathSync(snapshot.identity.devRepoRoot),
    realpathSync(root),
    'The renderer belongs to another checkout.'
  )
  assert.equal(snapshot.visible, false, 'Refusing to operate on a visible user window.')
  assert.equal(snapshot.runtime.state, 'ready')
}
