import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for main-window zoom parity: `poc_set_zoom` records the
// level (explicit or derived from a bare factor) and `poc_get_zoom` answers
// with the applied factor instead of the monitor DPI, matching Electron's
// `webFrame.getZoomFactor()`; out-of-range factors are rejected and the
// pre-probe zoom is restored. Refuses visible windows and foreign checkouts.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
let page
const invoke = (command, payload) =>
  page.evaluate((params) => window.__TAURI_INTERNALS__.invoke(params.command, params.payload), {
    command,
    payload
  })
const approx = (actual, expected, what) => {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9,
    `${what} missed: got ${JSON.stringify(actual)}, want ${expected}`
  )
}
try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const original = await invoke('poc_get_zoom', {})
  assert.ok(Number.isFinite(original), `initial zoom is not a number: ${JSON.stringify(original)}`)
  await invoke('poc_set_zoom', { scaleFactor: 1.2, zoomLevel: 1 })
  approx(await invoke('poc_get_zoom', {}), 1.2, 'explicit level round-trip')
  await invoke('poc_set_zoom', { scaleFactor: 1.44 })
  approx(await invoke('poc_get_zoom', {}), 1.44, 'bare factor round-trip')
  const rejected = await invoke('poc_set_zoom', { scaleFactor: 0.05 }).then(
    () => null,
    (error) => String((error && error.message) || error)
  )
  assert.ok(
    rejected && rejected.includes('outside the supported range'),
    `out-of-range factor was not rejected: ${rejected}`
  )
  await invoke('poc_set_zoom', { scaleFactor: original })
  approx(await invoke('poc_get_zoom', {}), original, 'zoom restore')
  await assertReadyHidden(page, root)
  console.log(JSON.stringify({ ok: true, at: new Date().toISOString() }))
} finally {
  for (const browser of connections) {
    await browser.close().catch(() => {})
  }
}
