import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for elevation parity: the dev Tauri app is not the
// installed Windows app, so the native command must report the same
// installed-app error Electron throws in dev instead of the web fallback or,
// worse, spawning the UAC helper from a hidden renderer.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
let page
try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const outcome = await page.evaluate(() =>
    window.api.app.restartAsAdministrator().then(
      () => ({ rejected: false, message: '' }),
      (error) => ({ rejected: true, message: String(error?.message ?? error) })
    )
  )
  assert.strictEqual(outcome.rejected, true, 'dev restart-as-administrator must not succeed')
  assert.match(outcome.message, /installed Windows app/)
  await assertReadyHidden(page, root)
  console.log(JSON.stringify({ ok: true, message: outcome.message, at: new Date().toISOString() }))
} finally {
  for (const browser of connections) {
    await browser.close().catch(() => {})
  }
}
