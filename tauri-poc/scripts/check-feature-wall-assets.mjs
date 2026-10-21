import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for feature-wall parity: the renderer base URL names
// the repo feature-wall dir through the same Vite /@fs route Electron dev
// uses, and the first tile poster loads as an image instead of the SPA
// fallback HTML the old `/` base resolved to. Refuses visible windows and
// foreign checkouts.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
let page
try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const base = await page.evaluate(() => window.api.app.getFeatureWallAssetBaseUrl())
  assert.ok(
    typeof base === 'string' && base.includes('/@fs/') && base.endsWith('feature-wall/'),
    `asset base outside the Vite fs route: ${JSON.stringify(base)}`
  )
  const probe = await page.evaluate(async (baseUrl) => {
    const response = await fetch(new URL('tile-01.poster.jpg', baseUrl).toString())
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      bytes: (await response.arrayBuffer()).byteLength
    }
  }, base)
  assert.strictEqual(probe.status, 200, `tile poster missed: ${JSON.stringify(probe)}`)
  assert.ok(
    (probe.contentType ?? '').startsWith('image/'),
    `tile poster is not an image: ${JSON.stringify(probe)}`
  )
  assert.ok(probe.bytes > 1024, `tile poster is suspiciously small: ${JSON.stringify(probe)}`)
  await assertReadyHidden(page, root)
  console.log(JSON.stringify({ ok: true, base, probe, at: new Date().toISOString() }))
} finally {
  for (const browser of connections) {
    await browser.close().catch(() => {})
  }
}
