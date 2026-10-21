import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for keep-awake parity: drive the Tauri Rust blocker with
// the exact payload the orcad-verdict bridge forwards, then verify the Rust
// state round-trips through both surfaces (direct command + window.api),
// the agentAwake:changed event reaches the renderer, and release resets the
// state. The unsafe SetThreadExecutionState call itself is covered by the
// Rust execution test in agent_awake.rs (powercfg /requests needs elevation
// on this host, so no user-mode probe can observe the OS request directly).
// Refuses visible windows and foreign checkouts, and always releases the
// blocker before exiting.
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
  const hasApi = await page.evaluate(() => Boolean(window.api?.agentAwake?.getStatus))
  assert.equal(hasApi, true, 'The Tauri renderer has no window.api.agentAwake.')
  // Start from a released blocker so a crashed earlier run cannot fake the proof.
  await invoke('poc_agent_awake_set_active', { mode: 'on', active: false })
  const baseline = await page.evaluate(() => window.api.agentAwake.getStatus())
  assert.equal(baseline.active, false, 'The blocker was already active before the check.')
  await page.evaluate(() => {
    window.__keepAwakeEvents = []
    window.api.agentAwake.onChanged((status) => {
      window.__keepAwakeEvents.push(status)
    })
  })
  const applied = await invoke('poc_agent_awake_set_active', { mode: 'on', active: true })
  assert.equal(applied.active, true, 'The Rust command did not report active.')
  assert.equal(applied.mode, 'on', 'The Rust command did not keep the mode.')
  const status = await page.evaluate(() => window.api.agentAwake.getStatus())
  assert.deepEqual(
    status,
    { mode: 'on', active: true },
    'window.api.agentAwake.getStatus() disagrees with the Rust command.'
  )
  const events = await page.evaluate(() => window.__keepAwakeEvents)
  assert.ok(
    events.some((event) => event.active === true && event.mode === 'on'),
    'No agentAwake:changed event reached the renderer while active.'
  )
  const released = await invoke('poc_agent_awake_set_active', { mode: 'on', active: false })
  assert.equal(released.active, false, 'The Rust command did not report released.')
  const afterRelease = await page.evaluate(() => window.api.agentAwake.getStatus())
  assert.deepEqual(
    afterRelease,
    { mode: 'on', active: false },
    'The Rust status did not reset after release.'
  )
  await assertReadyHidden(page, root)
  const evidence = { applied, status, releasedEvents: events, releasedAt: new Date().toISOString() }
  await writeFile(
    join(root, '.cache', 'tauri-keep-awake-check-latest.json'),
    JSON.stringify(evidence, null, 2)
  )
  console.log('Keep-awake round-trips through Rust state, event, and release.')
} finally {
  try {
    // Never strand a sleep assertion if the check fails halfway.
    await invoke('poc_agent_awake_set_active', { mode: 'off', active: false }).catch(() => {})
  } finally {
    await Promise.all([...connections].map((browser) => browser.close().catch(() => {})))
  }
}
