import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for floating workspace parity: the renderer floating reads must
// resolve real paths through the owned orcad runtime like Electron main, instead of the
// web empty-string fallbacks. Trust writes and markdown resolution are covered by unit
// tests only: they need a native picker a hidden renderer cannot drive.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
let page
try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const cwd = await page.evaluate(() => window.api.app.getFloatingTerminalCwd({}))
  assert.ok(
    typeof cwd === 'string' && cwd.length > 0,
    'floating terminal cwd must be a real path, got: ' + JSON.stringify(cwd)
  )
  const directory = await page.evaluate(() => window.api.app.getFloatingMarkdownDirectory())
  assert.ok(
    typeof directory === 'string' && directory.length > 0,
    'floating markdown directory must be a real path, got: ' + JSON.stringify(directory)
  )
  const trusted = await page.evaluate(() => window.api.app.getFloatingTerminalCwd({ requireTrusted: true }))
  assert.strictEqual(
    trusted,
    directory,
    'trusted cwd without a configured path must be the app-owned workspace: ' + JSON.stringify(trusted)
  )
  const fallback = await page.evaluate(() =>
    window.api.app.getFloatingTerminalCwd({ path: '/definitely/not/here-orca-floating-probe' })
  )
  assert.strictEqual(
    fallback,
    directory,
    'an unreachable configured path must fall back to the app-owned workspace: ' + JSON.stringify(fallback)
  )
  await assertReadyHidden(page, root)
  console.log(JSON.stringify({ ok: true, cwd, directory, at: new Date().toISOString() }))
} finally {
  for (const browser of connections) {
    await browser.close().catch(() => {})
  }
}
