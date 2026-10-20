import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
let page
try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const result = await page.evaluate(() => window.api.notifications.getDesktopAwayState())
  assert.ok(
    result === true || result === false || result === undefined,
    'away state must be boolean or undefined'
  )
  await assertReadyHidden(page, root)
  console.log(JSON.stringify({ ok: true, away: result ?? null, at: new Date().toISOString() }))
} finally {
  for (const browser of connections) {
    await browser.close().catch(() => {})
  }
}