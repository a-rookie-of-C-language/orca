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
  const result = await page.evaluate(async () => ({
    gitBash: await window.api.gitBash.isAvailable(),
    pwsh: await window.api.pwsh.isAvailable(),
    wsl: await window.api.wsl.isAvailable(),
    wslDistros: await window.api.wsl.listDistros()
  }))
  assert.strictEqual(typeof result.gitBash, 'boolean', 'gitBash must be a boolean')
  assert.strictEqual(typeof result.pwsh, 'boolean', 'pwsh must be a boolean')
  assert.strictEqual(typeof result.wsl, 'boolean', 'wsl must be a boolean')
  assert.ok(Array.isArray(result.wslDistros), 'wslDistros must be an array')
  await assertReadyHidden(page, root)
  console.log(JSON.stringify({ ok: true, ...result, at: new Date().toISOString() }))
} finally {
  for (const browser of connections) {
    await browser.close().catch(() => {})
  }
}
