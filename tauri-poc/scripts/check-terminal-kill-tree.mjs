import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof that closing a Tauri terminal pane kills the whole
// process tree like Electron: a grandchild `ping` started from the pane's
// shell must be gone after `pty.kill`, not orphaned. Refuses visible windows
// and foreign checkouts, and force-stops the marker when the assertion fails
// so a red run leaves no litter behind.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
const token = randomUUID().slice(0, 8)
let page
let victimId
let checkerId
async function spawn(extra = {}) {
  const terminal = await page.evaluate((options) => window.api.pty.spawn(options), {
    worktreeId: 'global-floating-terminal',
    cols: 80,
    rows: 24,
    initiallyHidden: true,
    shellOverride: 'powershell.exe',
    ...extra
  })
  return terminal.id
}
async function writeAccepted(id, text) {
  const accepted = await page.evaluate(
    (params) => window.api.pty.writeAccepted(params.id, params.text, 'driving'),
    { id, text }
  )
  assert.equal(accepted, true, 'The shell did not acknowledge the input.')
}
async function snapshot(id) {
  return (await page.evaluate((pid) => window.api.pty.getMainBufferSnapshot(pid), id))?.data ?? ''
}
async function waitFor(id, marker, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const data = await snapshot(id)
    const hit = typeof marker === 'string' ? data.includes(marker) : marker.test(data)
    if (hit) {
      return data
    }
    await delay(100)
  }
  assert.fail(`Timed out waiting for ${marker}.`)
}
try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const directory = await mkdtemp(join(root, '.cache', 'tauri-killtree-check-'))
  await mkdir(directory, { recursive: true })
  victimId = await spawn({ cwd: directory })
  await writeAccepted(
    victimId,
    `$p = Start-Process -FilePath "$env:SystemRoot\\System32\\ping.exe" -ArgumentList '127.0.0.1','-n','300' -WindowStyle Hidden -PassThru; Write-Output "killtree-${token}-child-$($p.Id)"\r`
  )
  const childPattern = new RegExp(`killtree-${token}-child-(\\d+)`)
  const childLine = await waitFor(victimId, childPattern)
  const childPid = Number(childLine.match(childPattern)?.[1])
  assert.ok(Number.isInteger(childPid) && childPid > 0, 'The marker child PID never surfaced.')
  await page.evaluate((pid) => window.api.pty.kill(pid), victimId)
  victimId = null
  checkerId = await spawn({ cwd: directory })
  let gone = false
  for (let attempt = 0; attempt < 100; attempt++) {
    await writeAccepted(
      checkerId,
      `if (Get-Process -Id ${childPid} -ErrorAction SilentlyContinue) { Write-Output "killtree-${token}-alive" } else { Write-Output "killtree-${token}-gone" }\r`
    )
    const data = await snapshot(checkerId)
    if (data.includes(`killtree-${token}-gone`)) {
      gone = true
      break
    }
    await delay(200)
  }
  console.log(`KILLTREE child=${childPid} gone=${gone}`)
  assert.equal(gone, true, 'The grandchild survived the pane kill; the tree is not reaped.')
} finally {
  try {
    if (page && !page.isClosed()) {
      if (checkerId) {
        await page
          .evaluate((pid) => window.api.pty.kill(pid).catch(() => {}), checkerId)
          .catch(() => {})
      }
      if (victimId) {
        await page
          .evaluate((pid) => window.api.pty.kill(pid).catch(() => {}), victimId)
          .catch(() => {})
      }
    }
  } finally {
    await Promise.all([...connections].map((browser) => browser.close().catch(() => {})))
  }
}
