import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for elevation-restart parity: the dev app never carries
// the helper marker, so taking the request must report false instead of
// restarting the owned daemon. The take-once latch also means a second take
// in the same process reports false.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
let page
try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const first = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke('poc_take_elevation_restart_request')
  )
  assert.strictEqual(first, false, 'dev boot must not carry the elevation marker')
  const second = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke('poc_take_elevation_restart_request')
  )
  assert.strictEqual(second, false, 'the take-once latch must hold within one process')
  await assertReadyHidden(page, root)
  console.log(JSON.stringify({ ok: true, at: new Date().toISOString() }))
} finally {
  for (const browser of connections) {
    await browser.close().catch(() => {})
  }
}
