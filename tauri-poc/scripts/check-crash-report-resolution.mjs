import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for requested/submit id resolution parity: seed one pending
// renderer error in the dev profile, then verify the three-way lookup (no args
// resolves pending, explicit empty lookup resolves nothing, explicit id resolves
// by id), and dismiss the seed to leave the profile clean. Submit itself is
// unit-proven only: a live submit would hit the real feedback endpoint.
// Refuses visible windows and foreign checkouts.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
let page
const invoke = (command, args) =>
  page.evaluate((params) => window.__TAURI_INTERNALS__.invoke(params.command, params.args), {
    command,
    args
  })
try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const seed = await invoke('poc_crash_reports_record_renderer_error', {
    args: {
      boundaryId: `resolve-probe-${Date.now()}`,
      surface: 'app-root',
      errorName: 'ProbeError',
      errorMessage: 'resolve parity probe'
    }
  })
  assert.equal(seed.ok, true, `seed failed: ${JSON.stringify(seed)}`)
  assert.equal(seed.deduped, false, 'seed was deduped')
  const seedId = seed.report.id
  const noArgs = await invoke('poc_crash_reports_get_requested')
  assert.equal(noArgs && noArgs.id, seedId, 'no-args lookup missed the pending seed')
  const emptyArgs = await invoke('poc_crash_reports_get_requested', { args: {} })
  assert.equal(
    emptyArgs,
    null,
    `empty lookup must resolve nothing, got: ${JSON.stringify(emptyArgs)}`
  )
  const byId = await invoke('poc_crash_reports_get_requested', {
    args: { reportId: seedId }
  })
  assert.equal(byId && byId.id, seedId, 'explicit id lookup failed')
  const dismissed = await invoke('poc_crash_reports_dismiss', {
    args: { reportId: seedId }
  })
  assert.equal(dismissed && dismissed.status, 'dismissed', 'dismiss failed')
  const afterDismiss = await invoke('poc_crash_reports_get_requested')
  assert.equal(afterDismiss, null, 'pending seed should be gone after dismiss')
  await assertReadyHidden(page, root)
  const evidence = { seedId, at: new Date().toISOString() }
  await writeFile(
    join(root, '.cache', 'tauri-crash-resolution-check-latest.json'),
    JSON.stringify(evidence, null, 2)
  )
  console.log('Crash report id resolution matches Electron against the live shell.')
} finally {
  for (const browser of connections) {
    await browser.close().catch(() => {})
  }
}
