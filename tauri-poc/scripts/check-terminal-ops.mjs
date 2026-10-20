import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'
// Live Windows proof that interrupt, buffer-clear and input-mode reset on the Tauri path
// behave like Electron: SIGINT ends the pane (ConPTY ignores the ETX byte, and
// process.kill(pid, 'SIGINT') on Windows is TerminateProcess, exit 1), while clear/reset
// leave a pane usable. Refuses visible windows and foreign checkouts.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
const token = randomUUID().slice(0, 8)
let page
const spawned = []
async function spawn(extra = {}) {
  const terminal = await page.evaluate((options) => window.api.pty.spawn(options), {
    worktreeId: 'global-floating-terminal',
    cwd: extra.cwd,
    cols: 80,
    rows: 24,
    initiallyHidden: true,
    shellOverride: 'powershell.exe',
    ...extra
  })
  spawned.push(terminal.id)
  return terminal.id
}
async function readOutput(id, marker, attempts = 300) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const snapshot = await page.evaluate((pid) => window.api.pty.getMainBufferSnapshot(pid), id)
    if (snapshot?.data?.includes(marker)) {
      return snapshot
    }
    await delay(100)
  }
  assert.fail(`Shell output did not contain ${marker}.`)
}
async function waitForExit(id, attempts = 150) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const found = await page.evaluate(
      (pid) => (window.__tauriOpsExits ?? []).find((event) => event.id === pid) ?? null,
      id
    )
    if (found) {
      return found
    }
    await delay(100)
  }
  assert.fail(`Pane ${id} did not report an exit.`)
}
try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  await page.evaluate(() => {
    window.__tauriOpsExits = []
    window.api.pty.onExit((event) => {
      window.__tauriOpsExits.push({ id: event.id, code: event.code })
    })
  })
  const directory = await mkdtemp(join(root, '.cache', 'tauri-ops-check-'))
  await mkdir(directory, { recursive: true })
  const id = await spawn({ cwd: directory })
  const accepted = await page.evaluate(
    ({ pid, marker }) =>
      window.api.pty.writeAccepted(pid, `Write-Output 'ops-${marker}-ready'\r`, 'driving'),
    { pid: id, marker: token }
  )
  assert.equal(accepted, true, 'The shell did not acknowledge the input.')
  await readOutput(id, `ops-${token}-ready`)
  // Interrupt a running command like Electron's Ctrl+C on Windows: wait for visible loop
  // output so the signal lands mid-run (not during shell startup), then the pane must exit
  // with code 1 instead of returning to its prompt.
  await page.evaluate(
    ({ pid, marker }) =>
      window.api.pty.writeAccepted(
        pid,
        `1..60 | % { Write-Output "ops-${marker}-tick-$_"; Start-Sleep -Seconds 1 }\r`,
        'driving'
      ),
    { pid: id, marker: token }
  )
  await readOutput(id, `ops-${token}-tick-2`)
  await page.evaluate((pid) => window.api.pty.signal(pid, 'SIGINT'), id)
  const exit = await waitForExit(id)
  assert.equal(exit.code, 1, 'SIGINT must end the Windows pane with exit code 1.')
  // Clearing the buffer and resetting input modes must not break a pane, so they run on a
  // fresh pane: the interrupted one is gone by design.
  const afterId = await spawn({ cwd: directory })
  const afterAccepted = await page.evaluate(
    ({ pid, marker }) =>
      window.api.pty.writeAccepted(pid, `Write-Output 'ops-${marker}-ready2'\r`, 'driving'),
    { pid: afterId, marker: token }
  )
  assert.equal(afterAccepted, true, 'The fresh shell did not acknowledge the input.')
  await readOutput(afterId, `ops-${token}-ready2`)
  await page.evaluate((pid) => window.api.pty.clearBuffer(pid), afterId)
  await page.evaluate((pid) => window.api.pty.resetInputModes(pid), afterId)
  await page.evaluate(
    ({ pid, marker }) =>
      window.api.pty.writeAccepted(pid, `Write-Output 'ops-${marker}-afterclear'\r`, 'driving'),
    { pid: afterId, marker: token }
  )
  await readOutput(afterId, `ops-${token}-afterclear`)
  await assertReadyHidden(page, root)
  await writeFile(
    join(root, '.cache', 'tauri-terminal-ops-check-latest.json'),
    JSON.stringify({ token, sigintExit: exit, at: new Date().toISOString() }, null, 2)
  )
  console.log('Local terminal ops match Electron (SIGINT exit 1, clearBuffer, resetInputModes).')
} finally {
  try {
    for (const id of spawned) {
      await page?.evaluate((pid) => window.api.pty.kill(pid).catch(() => {}), id).catch(() => {})
    }
  } finally {
    await Promise.all([...connections].map((browser) => browser.close().catch(() => {})))
  }
}
