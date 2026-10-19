import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()

// Live Windows proof for the client-route partition stores: resolving a route identity
// names its jar, re-resolves return the bound partition, environments never share a jar,
// the authority note/import/close path settles through the host-owned authority, and
// source badges record/list through the host-owned store. Refuses visible windows
// and foreign checkouts like the sibling checks.

function step(message) {
  console.log(`[client-route-partition-check] ${message}`)
}

async function invoke(page, command, args) {
  return page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, { args }),
    { command, args }
  )
}

let page
try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  step('renderer ready and hidden')

  const env = `live-partition-${Date.now().toString(36)}`
  const first = await invoke(page, 'poc_browser_client_route_resolve_partition', {
    environmentId: env,
    profileId: 'default',
    executionHostKey: 'native:1'
  })
  assert.match(first.partition, /^persist:tauri-browser-v1-default-[0-9a-f]{16}$/)
  assert.match(first.bindingFingerprint, /^[0-9a-f]{64}$/)
  step(`resolve names jar ${first.partition}`)

  const second = await invoke(page, 'poc_browser_client_route_resolve_partition', {
    environmentId: env,
    profileId: 'default',
    executionHostKey: 'native:1'
  })
  assert.deepEqual(second, first, 'Re-resolve must return the bound partition.')
  step('re-resolve returns the bound partition')

  const otherEnv = await invoke(page, 'poc_browser_client_route_resolve_partition', {
    environmentId: `${env}-other`,
    profileId: 'default',
    executionHostKey: 'native:1'
  })
  assert.notEqual(otherEnv.partition, first.partition, 'Environments must not share a jar.')
  step('environment isolation holds live')

  const noted = await invoke(page, 'poc_browser_client_route_note_authority', {
    environmentId: env,
    authorityRuntimeId: 'runtime-live',
    authorityEpoch: 'epoch-live',
    browserHostClientId: 'host-live',
    browserHostGeneration: 3,
    executionHostKey: 'native:1'
  })
  assert.equal(noted, true)
  // Import validates through the owned authority; an unknown browser family
  // exercises the full resolve/import/settle path without touching real jars.
  const refused = await invoke(page, 'poc_browser_client_route_import_from_browser', {
    environmentId: env,
    profileId: 'default',
    executionHostKey: 'native:1',
    browserFamily: 'no-such-browser-family'
  })
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /not found on this system/)
  step('import validates the source through the owned authority')
  const closed = await invoke(page, 'poc_browser_client_route_close_authority', {
    environmentId: env
  })
  assert.equal(closed, true)

  const badgeSource = { browserFamily: 'chrome', profileName: 'Default', importedAt: Date.now() }
  const recorded = await invoke(page, 'poc_browser_client_route_record_source', {
    environmentId: env,
    profileId: 'default',
    source: badgeSource
  })
  assert.equal(recorded, true)
  const listed = await invoke(page, 'poc_browser_client_route_list_sources', {
    environmentId: env
  })
  assert.deepEqual(listed.default.browserFamily, 'chrome')
  step('badge record/list round-trips through the host store')

  await mkdir(join(root, 'tauri-poc', '.cache'), { recursive: true })
  await writeFile(
    join(root, '.cache', 'tauri-client-route-partition-check-latest.json'),
    JSON.stringify(
      { partition: first.partition, fingerprint: first.bindingFingerprint, env },
      null,
      2
    )
  )
  step('evidence written')
} finally {
  for (const browser of connections) {
    await browser.close().catch(() => {})
  }
}
console.log('[client-route-partition-check] passed')
