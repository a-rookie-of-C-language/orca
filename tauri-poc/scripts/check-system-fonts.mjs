import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for settings font parity: the renderer listFonts call
// must return the installed families through the Rust GDI enumeration like
// Electron main, instead of the web empty-list fallback.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
let page
try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const fonts = await page.evaluate(() => window.api.settings.listFonts())
  assert.ok(Array.isArray(fonts), 'listFonts must resolve to an array')
  assert.ok(fonts.length > 0, 'listFonts must not fall back to an empty list')
  const sorted = [...fonts].sort()
  assert.deepStrictEqual(fonts, sorted, 'families must arrive sorted like Electron')
  assert.ok(
    fonts.includes('Consolas') || fonts.includes('Cascadia Mono'),
    'expected a stock Windows family in ' + fonts.slice(0, 8).join(', ')
  )
  await assertReadyHidden(page, root)
  console.log(
    JSON.stringify({ ok: true, count: fonts.length, at: new Date().toISOString() })
  )
} finally {
  for (const browser of connections) {
    await browser.close().catch(() => {})
  }
}
