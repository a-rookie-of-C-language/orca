import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for administrator-status parity: the renderer answer
// must equal a direct probe of the same bundled launcher Electron main
// runs (`orca.exe --orca-administrator-status`, 3s budget, trimmed
// true/false stdout). A missing launcher means null on both shells.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
let page
function directProbe() {
  if (process.platform !== 'win32') {
    return null
  }
  const launcher = join(root, 'native', 'windows-cli-launcher', '.build', 'orca.exe')
  if (!existsSync(launcher)) {
    return null
  }
  const probe = spawnSync(launcher, ['--orca-administrator-status'], {
    timeout: 3000,
    encoding: 'utf8',
    maxBuffer: 64,
    windowsHide: true
  })
  if (probe.error || probe.status !== 0) {
    return null
  }
  const answer = String(probe.stdout ?? '').trim()
  return answer === 'true' ? true : answer === 'false' ? false : null
}
try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const reported = await page.evaluate(() => window.api.app.getWindowsAdministratorStatus())
  assert.ok(
    reported === true || reported === false || reported === null,
    `administrator status outside the Electron vocabulary: ${JSON.stringify(reported)}`
  )
  const expected = directProbe()
  assert.strictEqual(
    reported,
    expected,
    `Rust probe ${JSON.stringify(reported)} disagrees with the direct launcher probe ${JSON.stringify(expected)}`
  )
  await assertReadyHidden(page, root)
  console.log(JSON.stringify({ ok: true, reported, at: new Date().toISOString() }))
} finally {
  for (const browser of connections) {
    await browser.close().catch(() => {})
  }
}
