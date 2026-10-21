import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof of Tauri/Electron foreground-confirm parity: the cached
// inspection read and the fresh confirm scan must agree on the shell, exactly
// like Electron's pty:confirmForegroundProcess IPC backing the same panes.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
let page
let terminalId
try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const directory = await mkdtemp(join(root, '.cache', 'tauri-confirm-check-'))
  await mkdir(directory, { recursive: true })
  const terminal = await page.evaluate((options) => window.api.pty.spawn(options), {
    worktreeId: 'global-floating-terminal',
    cwd: directory,
    cols: 80,
    rows: 24,
    initiallyHidden: true,
    shellOverride: 'powershell.exe'
  })
  terminalId = terminal.id
  const accepted = await page.evaluate(
    (pid) => window.api.pty.writeAccepted(pid, "Write-Output 'confirm-ready'\r", 'driving'),
    terminalId
  )
  assert.equal(accepted, true, 'The shell did not acknowledge the input.')
  let cached = null
  for (let attempt = 0; attempt < 200; attempt++) {
    cached = await page.evaluate((pid) => window.api.pty.getForegroundProcess(pid), terminalId)
    if (cached) {
      break
    }
    await delay(100)
  }
  const fresh = await page.evaluate(
    (pid) => window.api.pty.confirmForegroundProcess(pid),
    terminalId
  )
  console.log(`CONFIRM-PARITY cached=${cached} fresh=${fresh}`)
  assert.ok(cached, 'The cached inspection read answered nothing; cannot prove parity.')
  assert.ok(fresh, 'The fresh confirm scan answered nothing; the gap is still open.')
  assert.equal(fresh, cached, 'The fresh confirm scan disagrees with the cached read.')
} finally {
  try {
    if (terminalId && page && !page.isClosed()) {
      await page
        .evaluate((pid) => window.api.pty.kill(pid).catch(() => {}), terminalId)
        .catch(() => {})
    }
  } finally {
    await Promise.all([...connections].map((browser) => browser.close().catch(() => {})))
  }
}
