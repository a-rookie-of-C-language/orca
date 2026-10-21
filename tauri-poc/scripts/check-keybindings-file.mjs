import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for keybindings file parity: the renderer keybindings
// surface must resolve `~/.orca/keybindings.json` through the Rust file IO
// commands like Electron's KeybindingService, not the browser localStorage
// fallback path.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
let page
try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const snapshot = await page.evaluate(() => window.api.keybindings.get())
  assert.ok(snapshot && typeof snapshot === 'object', 'keybindings.get must return a snapshot')
  assert.ok(
    snapshot.path.endsWith('.orca\\keybindings.json') || snapshot.path.endsWith('.orca/keybindings.json'),
    'snapshot.path must point at the user keybindings file, got ' + snapshot.path
  )
  assert.notStrictEqual(
    snapshot.path,
    'Browser local storage',
    'must not fall back to browser local storage'
  )
  assert.strictEqual(snapshot.platform, 'win32', 'platform must resolve to win32 on Windows')
  // ensureFile creates the document on disk and reports exists:true.
  const ensured = await page.evaluate(() => window.api.keybindings.ensureFile())
  assert.strictEqual(ensured.exists, true, 'ensureFile must report exists:true')
  assert.strictEqual(ensured.path, snapshot.path)
  console.log(JSON.stringify({ ok: true, path: ensured.path, at: new Date().toISOString() }))
} finally {
  for (const browser of connections) {
    await browser.close().catch(() => {})
  }
}