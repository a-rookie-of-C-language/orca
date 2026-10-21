import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'
// Live Windows proof that a local terminal on the Tauri path behaves like Electron: spawn a
// hidden PowerShell, drive a command and read its output, resize and re-read the size, exit
// with a code and observe it, then spawn a sleeper and kill it. Refuses visible windows and
// foreign checkouts.
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
async function readOutput(id, marker) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const snapshot = await page.evaluate((pid) => window.api.pty.getMainBufferSnapshot(pid), id)
    if (snapshot?.data?.includes(marker)) {
      return snapshot
    }
    await delay(100)
  }
  assert.fail(`Shell output did not contain ${marker}.`)
}
async function waitExit(id) {
  return page.evaluate(
    (pid) =>
      new Promise((resolveExit, rejectExit) => {
        const timer = setTimeout(
          () => rejectExit(new Error('Timed out waiting for pty exit.')),
          30000
        )
        const off = window.api.pty.onExit((event) => {
          if (event.id === pid) {
            clearTimeout(timer)
            off()
            resolveExit(event)
          }
        })
      }),
    id
  )
}
try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const directory = await mkdtemp(join(root, '.cache', 'tauri-lifecycle-check-'))
  await mkdir(directory, { recursive: true })
  const id = await spawn({ cwd: directory })
  const accepted = await page.evaluate(
    ({ pid, marker }) =>
      window.api.pty.writeAccepted(pid, `Write-Output 'lifecycle-${marker}'\r`, 'driving'),
    { pid: id, marker: token }
  )
  assert.equal(accepted, true, 'The shell did not acknowledge the input.')
  await readOutput(id, `lifecycle-${token}`)
  await page.evaluate((pid) => window.api.pty.resize(pid, 100, 30), id)
  let size = null
  for (let attempt = 0; attempt < 100; attempt++) {
    size = await page.evaluate((pid) => window.api.pty.getSize(pid), id)
    if (size?.cols === 100 && size?.rows === 30) {
      break
    }
    await delay(100)
  }
  assert.deepEqual(size, { cols: 100, rows: 30 }, `Resize did not stick: ${JSON.stringify(size)}.`)
  const cwd = await page.evaluate((pid) => window.api.pty.getCwd(pid), id)
  assert.ok(cwd, 'The terminal reported no working directory.')
  const exitPromise = waitExit(id)
  await page.evaluate((pid) => window.api.pty.writeAccepted(pid, 'exit 42\r', 'driving'), id)
  const exit = await exitPromise
  assert.equal(exit.code, 42, `Expected exit code 42, got ${exit.code}.`)
  const sleeper = await spawn({ cwd: directory })
  const killExit = waitExit(sleeper)
  await page.evaluate(
    (pid) => window.api.pty.writeAccepted(pid, 'Start-Sleep -Seconds 120\r', 'driving'),
    sleeper
  )
  await delay(2000)
  await page.evaluate((pid) => window.api.pty.kill(pid), sleeper)
  const killed = await killExit
  assert.ok(Number.isInteger(killed.code), `Kill produced no exit code: ${killed.code}.`)
  await assertReadyHidden(page, root)
  const evidence = {
    token,
    exitCode: exit.code,
    killCode: killed.code,
    size,
    at: new Date().toISOString()
  }
  await writeFile(
    join(root, '.cache', 'tauri-terminal-lifecycle-check-latest.json'),
    JSON.stringify(evidence, null, 2)
  )
  console.log(`Local terminal lifecycle matches Electron (exit ${exit.code}, kill ${killed.code}).`)
} finally {
  try {
    for (const id of spawned) {
      await page?.evaluate((pid) => window.api.pty.kill(pid).catch(() => {}), id).catch(() => {})
    }
  } finally {
    await Promise.all([...connections].map((browser) => browser.close().catch(() => {})))
  }
}
