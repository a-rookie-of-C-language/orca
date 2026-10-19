import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
const token = randomUUID()
const windows = process.platform === 'win32'
const tabId = `tauri-restore-${randomUUID()}`
const leafId = randomUUID()
let page
let terminalId

async function readOutput(marker) {
  let snapshot
  for (let attempt = 0; attempt < 200; attempt++) {
    snapshot = await page.evaluate((id) => window.api.pty.getMainBufferSnapshot(id), terminalId)
    if (snapshot?.data?.includes(marker)) {
      return snapshot
    }
    await delay(100)
  }
  assert.fail(`Shell output did not contain ${marker}; snapshot=${JSON.stringify(snapshot)}`)
}

async function send(command) {
  const accepted = await page.evaluate(
    ({ id, command }) => window.api.pty.writeAccepted(id, `${command}\r`, 'driving'),
    { id: terminalId, command }
  )
  assert.equal(accepted, true, 'The shell did not acknowledge the input.')
}

async function spawn(directory) {
  const terminal = await page.evaluate((options) => window.api.pty.spawn(options), {
    worktreeId: 'global-floating-terminal',
    tabId,
    leafId,
    cwd: directory,
    cols: 100,
    rows: 30,
    initiallyHidden: true,
    ...(windows ? { shellOverride: 'powershell.exe' } : {})
  })
  terminalId = terminal.id
  return terminal
}

try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const cache = join(root, '.cache')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'tauri-restore-check-'))
  const first = await spawn(directory)
  await send(
    windows
      ? `$global:OrcaRestoreToken='${token}'; $global:OrcaRestorePid=$PID; Write-Output ('restore-' + $global:OrcaRestoreToken + '-before')`
      : `ORCA_RESTORE_TOKEN='${token}'; ORCA_RESTORE_PID=$$; printf 'restore-%s-before\n' "$ORCA_RESTORE_TOKEN"`
  )
  await readOutput(`restore-${token}-before`)
  const evidence = { before: first, phases: [], verifiedAt: null }

  for (const action of ['reload', 'restart']) {
    await assertReadyHidden(page, root)
    const event = page.waitForEvent(action === 'reload' ? 'load' : 'close', { timeout: 40000 })
    await page.evaluate((action) => {
      void window.api.app[action]()
    }, action)
    await event
    if (action !== 'reload') {
      page = await connectDevelopmentRenderer(endpoint, connections)
    }
    await assertReadyHidden(page, root)
    const restored = await spawn(directory)
    assert.equal(restored.isReattach, true, `${action} spawned a new shell instead of adopting it.`)
    assert.equal(
      restored.incarnationId,
      first.incarnationId,
      `${action} changed the shell lifetime.`
    )
    await readOutput(`restore-${token}-before`)
    await send(
      windows
        ? `if ($PID -eq $global:OrcaRestorePid) { Write-Output ('restore-' + $global:OrcaRestoreToken + '-${action}') }`
        : `if [ "$$" = "$ORCA_RESTORE_PID" ]; then printf 'restore-%s-${action}\n' "$ORCA_RESTORE_TOKEN"; fi`
    )
    await readOutput(`restore-${token}-${action}`)
    assert.deepEqual(await page.evaluate((id) => window.api.pty.getSize(id), terminalId), {
      cols: 100,
      rows: 30
    })
    evidence.phases.push({ action, restored, sameShell: true, scrollbackRetained: true })
    console.log(`${action}: same shell, incarnation, prior output, and continued input verified.`)
  }
  await assertReadyHidden(page, root)
  evidence.verifiedAt = new Date().toISOString()
  await writeFile(join(cache, 'tauri-restore-check-latest.json'), JSON.stringify(evidence, null, 2))
} finally {
  try {
    if (terminalId && page && !page.isClosed()) {
      await page.evaluate((id) => window.api.pty.kill(id), terminalId)
    }
  } finally {
    await Promise.all([...connections].map((browser) => browser.close().catch(() => {})))
  }
}
