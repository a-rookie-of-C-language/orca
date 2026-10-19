import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertReadyHidden,
  connectDevelopmentRenderer
} from '../scripts/hidden-renderer-connection.mjs'

// Live Windows proof for dismissAvailableUpdate parity: resolve a real pinned build
// against the GitHub release list (read-only), check it to stage the channel card,
// dismiss it, and verify the status returns to idle with the pin cleared (a later
// download reports no update instead of the channel guided error). Refuses
// visible windows and foreign checkouts.
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
  const version = await invoke('poc_updater_get_version')
  const listed = await invoke('poc_updater_list_builds', { args: { channel: 'rc' } })
  assert.equal(listed.ok, true, `build list failed: ${JSON.stringify(listed)}`)
  const target = (listed.builds ?? []).find((build) => build.version !== version)
  assert.ok(target, `no build different from ${version} to pin`)
  const checked = await invoke('poc_updater_check', {
    args: { userInitiated: true, channel: 'rc', targetTag: target.tag }
  })
  assert.equal(checked.state, 'available', `pinned check missed: ${JSON.stringify(checked)}`)
  await invoke('poc_updater_dismiss_available_update')
  const status = await invoke('poc_updater_get_status')
  assert.equal(status.state, `idle`, `dismiss did not idle, got: ${JSON.stringify(status)}`)
  const downloadError = await invoke('poc_updater_download').then(
    () => null,
    (error) => String((error && error.message) || error)
  )
  assert.ok(
    downloadError && downloadError.includes('No update is available to download.'),
    `pin was not cleared, download said: ${downloadError}`
  )
  await assertReadyHidden(page, root)
  console.log(JSON.stringify({ ok: true, tag: target.tag, at: new Date().toISOString() }))
} finally {
  for (const browser of connections) {
    await browser.close().catch(() => {})
  }
}
