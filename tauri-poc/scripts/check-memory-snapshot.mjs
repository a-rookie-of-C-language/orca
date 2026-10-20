import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for the Resource Manager host block: the renderer
// memory.getSnapshot call must return real GlobalMemoryStatusEx totals via
// the Rust command instead of the all-zeros web fallback.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
let page
try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const snapshot = await page.evaluate(() => window.api.memory.getSnapshot())
  const host = snapshot?.host
  assert.ok(host, 'snapshot.host must be present')
  assert.ok(host.totalMemory > 0, 'totalMemory must be non-zero on Windows')
  assert.ok(
    host.availableMemory > 0 && host.availableMemory <= host.totalMemory,
    `availableMemory ${host.availableMemory} must be within total ${host.totalMemory}`
  )
  assert.strictEqual(
    host.usedMemory,
    host.totalMemory - host.availableMemory,
    'usedMemory must equal total - available'
  )
  assert.ok(host.memoryUsagePercent >= 0 && host.memoryUsagePercent <= 100)
  assert.ok(host.cpuCoreCount >= 1, 'cpuCoreCount must be >= 1')
  assert.strictEqual(snapshot.processMemoryMetric, 'working-set')
  assert.ok(Array.isArray(snapshot.worktrees), 'worktrees must be an array')
  console.log(
    JSON.stringify({
      ok: true,
      totalGB: Math.round(host.totalMemory / 1024 / 1024 / 1024),
      usedPercent: Math.round(host.memoryUsagePercent),
      cores: host.cpuCoreCount,
      at: new Date().toISOString()
    })
  )
} finally {
  for (const browser of connections) {
    await browser.close().catch(() => {})
  }
}