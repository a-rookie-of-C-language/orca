import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
let page
async function spawn(directory) {
  const terminal = await page.evaluate(
    (dir) =>
      window.api.pty.spawn({
        worktreeId: 'global-floating-terminal',
        cwd: dir,
        cols: 80,
        rows: 24,
        initiallyHidden: true,
        shellOverride: 'powershell.exe'
      }),
    directory
  )
  return terminal.id
}
async function waitExit(id) {
  return page.evaluate(
    (pid) =>
      new Promise((resolveExit, rejectExit) => {
        const timer = setTimeout(() => rejectExit(new Error('timeout')), 30000)
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
  const directory = await mkdtemp(join(root, '.cache', 'tauri-exit-debug-'))
  await mkdir(directory, { recursive: true })
  const id = await spawn(directory)
  const exitPromise = waitExit(id)
  await page.evaluate((pid) => window.api.pty.writeAccepted(pid, 'exit 42\r', 'driving'), id)
  const exit = await exitPromise
  console.log('RAW-EXIT-EVENT ' + JSON.stringify(exit))
} finally {
  await Promise.all([...connections].map((browser) => browser.close().catch(() => {})))
}
