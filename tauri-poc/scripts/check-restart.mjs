import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
assert.equal(new URL(endpoint).hostname, '127.0.0.1', 'Only a local CDP endpoint is allowed.')
assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1', 'Run checks with ORCA_BACKGROUND_LAUNCH=1.')
const profile =
  process.env.ORCA_TAURI_RUNTIME_PROFILE ?? resolve(root, '.cache/tauri-orcad-profile')
const screenshotDirectory = resolve(root, '.cache/tauri-restart-check')
const connections = new Set()

async function runtimeIdentity() {
  const { pid, runtimeId } = JSON.parse(
    await readFile(resolve(profile, 'orca-runtime.json'), 'utf8')
  )
  return { pid, runtimeId }
}

try {
  await mkdir(screenshotDirectory, { recursive: true })
  let page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const before = await runtimeIdentity()
  await page.screenshot({ path: resolve(screenshotDirectory, 'before.png') })

  const loaded = page.waitForEvent('load', { timeout: 30000 })
  await page.evaluate(() => {
    void window.api.app.reload().catch((error) => {
      document.documentElement.dataset.restartSmokeError = error.message
    })
  })
  await loaded
  await assertReadyHidden(page, root)
  assert.deepEqual(await runtimeIdentity(), before, 'Reload replaced the runtime owner.')

  for (const action of ['restart', 'relaunch']) {
    const previous = await runtimeIdentity()
    const closed = page.waitForEvent('close', { timeout: 40000 })
    await page.evaluate((method) => {
      void window.api.app[method]().catch((error) => {
        document.documentElement.dataset.restartSmokeError = error.message
      })
    }, action)
    await closed
    page = await connectDevelopmentRenderer(endpoint, connections)
    await assertReadyHidden(page, root)
    const next = await runtimeIdentity()
    assert.notEqual(next.pid, previous.pid, `${action} did not replace the runtime process.`)
    assert.notEqual(next.runtimeId, previous.runtimeId, `${action} reused the previous runtime.`)
    assert.equal((await fetch('http://127.0.0.1:5174/web-index.html')).status, 200)
    await page.screenshot({ path: resolve(screenshotDirectory, `${action}.png`) })
    console.log(`${action}: runtime ${previous.pid} -> ${next.pid}; renderer ready and hidden.`)
  }
  console.log(`Reload preserved the runtime. Screenshots: ${screenshotDirectory}`)
} finally {
  // CDP browser.close disconnects the transport; it does not close the native app.
  await Promise.all([...connections].map((browser) => browser.close().catch(() => {})))
}
