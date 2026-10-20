import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, normalize, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
let page
let terminalId

async function waitForCwd(expected) {
  let actual = ''
  for (let attempt = 0; attempt < 200; attempt++) {
    actual = await page.evaluate((id) => window.api.pty.getCwd(id), terminalId)
    if (normalize(actual) === normalize(expected)) {
      return actual
    }
    await delay(100)
  }
  assert.equal(normalize(actual), normalize(expected), 'The terminal directory did not update.')
}

try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const cache = join(root, '.cache')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'tauri-cwd-check-'))
  const nested = join(directory, "space #中文%'quote")
  await mkdir(nested)
  const terminal = await page.evaluate(
    async ({ directory, windows }) =>
      window.api.pty.spawn({
        worktreeId: 'global-floating-terminal',
        cwd: directory,
        cols: 80,
        rows: 24,
        initiallyHidden: true,
        ...(windows ? { shellOverride: 'powershell.exe' } : {})
      }),
    { directory, windows: process.platform === 'win32' }
  )
  terminalId = terminal.id
  const initial = await waitForCwd(directory)
  const command =
    process.platform === 'win32'
      ? `Set-Location -LiteralPath '${nested.replaceAll("'", "''")}'`
      : `cd -- '${nested.replaceAll("'", "'\\''")}'`
  const accepted = await page.evaluate(
    ({ id, command }) =>
      window.api.pty.writeAccepted(id, command + String.fromCharCode(13), 'driving'),
    { id: terminalId, command }
  )
  assert.equal(accepted, true, 'The real shell did not accept the directory-change command.')
  const current = await waitForCwd(nested)
  const size = await page.evaluate((id) => window.api.pty.getSize(id), terminalId)
  assert.deepEqual(size, { cols: 80, rows: 24 })
  await assertReadyHidden(page, root)
  const evidence = { initial, current, size, verifiedAt: new Date().toISOString() }
  await writeFile(join(cache, 'tauri-cwd-check-latest.json'), JSON.stringify(evidence, null, 2))
  console.log('Real terminal cwd changed after cd; escaped path and 80x24 viewport verified.')
} finally {
  try {
    // Close only this check's pane; never restart a daemon or stop unrelated terminals.
    if (terminalId) {
      await page.evaluate((id) => window.api.pty.kill(id), terminalId)
    }
  } finally {
    await Promise.all([...connections].map((browser) => browser.close().catch(() => {})))
  }
}
