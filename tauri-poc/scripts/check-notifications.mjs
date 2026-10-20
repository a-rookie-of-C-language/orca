import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof that the notification plugin is registered: the
// permission query and a labeled notify/remove_active round-trip must resolve
// instead of rejecting with plugin-not-registered. Refuses visible windows.
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
  const granted = await invoke('plugin:notification|is_permission_granted', {})
  console.log('PERMISSION ' + JSON.stringify(granted))
  const probeId = 424242
  await invoke('plugin:notification|notify', {
    options: { id: probeId, title: 'Orca POC probe', body: 'notification registration check' }
  })
  await invoke('plugin:notification|remove_active', { notifications: [{ id: probeId }] })
  await assertReadyHidden(page, root)
  const evidence = {
    permissionGranted: granted,
    notifyResolved: true,
    removeActiveResolved: true,
    at: new Date().toISOString()
  }
  await writeFile(
    join(root, '.cache', 'tauri-notifications-check-latest.json'),
    JSON.stringify(evidence, null, 2)
  )
  console.log('notification plugin registered and round-trips')
} finally {
  for (const browser of connections) {
    await browser.close().catch(() => {})
  }
}
