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
  const result = await page.evaluate(() => window.api.settings.previewGhosttyImport())
  assert.ok(result !== null && typeof result === 'object', 'preview must resolve to an object')
  assert.strictEqual(typeof result.found, 'boolean', 'found must be a boolean')
  assert.ok(Array.isArray(result.unsupportedKeys), 'unsupportedKeys must be an array')
  assert.ok(result.diff !== null && typeof result.diff === 'object', 'diff must be an object')
  await assertReadyHidden(page, root)
  console.log(
    JSON.stringify({ ok: true, found: result.found, at: new Date().toISOString() })
  )
} finally {
  for (const browser of connections) {
    await browser.close().catch(() => {})
  }
}
