import assert from 'node:assert/strict'
import { readFile, rm, stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for render-desync evidence parity: the renderer call must
// persist PNG + metadata sidecars under the app-owned profile like Electron
// main writes under userData, instead of the web reject fallback.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const captureId = 'orcad-tauri-desync-probe'
const connections = new Set()
let page
try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const result = await page.evaluate(
    (id) =>
      window.api.app.writeTerminalRenderDesyncEvidence({
        captureId: id,
        phase: 'corrupt',
        pngDataUrl: 'data:image/png;base64,aGk=',
        metadata: { probe: true }
      }),
    captureId
  )
  assert.strictEqual(basename(dirname(result.directory)), 'terminal-render-desync-evidence')
  assert.strictEqual(basename(result.directory), captureId)
  assert.strictEqual(result.pngPath, `${result.directory}\\corrupt.png`)
  assert.strictEqual(result.metadataPath, `${result.directory}\\corrupt.json`)
  const png = await readFile(result.pngPath)
  assert.deepStrictEqual(png, Buffer.from('hi'))
  const metadata = JSON.parse(await readFile(result.metadataPath, 'utf8'))
  assert.deepStrictEqual(metadata, { probe: true })
  await stat(result.directory)
  await rm(result.directory, { recursive: true, force: true })
  await assertReadyHidden(page, root)
  console.log(
    JSON.stringify({ ok: true, directory: result.directory, at: new Date().toISOString() })
  )
} finally {
  for (const browser of connections) {
    await browser.close().catch(() => {})
  }
}
