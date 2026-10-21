import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for shell open-path ownership parity: SSH and absent
// owners, relative and missing local paths are refused with Electron's reason
// vocabulary, remote-host file URIs never resolve, and the existence-batch cap
// holds — all without opening any OS surface. Positive opens stay covered by
// unit tests, since revealing or launching would pop OS UI.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
let page
const call = (method, ...args) =>
  page.evaluate(
    (params) => window.api.shell[params.method](...params.args),
    { method, args }
  )
try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const missing = 'C:\\orca-shell-ownership-probe-missing\\a.txt'
  const notFound = await call('openInFileManager', missing, 'local')
  assert.deepEqual(notFound, { ok: false, reason: 'not-found' })
  const notAbsolute = await call('openInFileManager', 'relative\\a.txt', 'local')
  assert.deepEqual(notAbsolute, { ok: false, reason: 'not-absolute' })
  const sshRefused = await call('openInFileManager', 'C:\\Windows', 'ssh:probe')
  assert.deepEqual(sshRefused, { ok: false, reason: 'remote-runtime-unsupported' })
  const absentRefused = await call('openInFileManager', 'C:\\Windows', null)
  assert.deepEqual(absentRefused, { ok: false, reason: 'remote-runtime-unsupported' })
  const openDenied = await call('openFilePath', missing, 'local')
  assert.equal(openDenied, false)
  const openSshDenied = await call('openFilePath', 'C:\\Windows', 'ssh:probe')
  assert.equal(openSshDenied, false)
  await call('openPath', missing, 'local')
  await call('openFileUri', 'file://remote-host/C:/Windows', 'local')
  // Why silent: Electron drops bad schemes and malformed URLs without
  // throwing, and these calls are fire-and-forget, so a rejection here
  // would be an unhandled live failure.
  await call('openFileUri', 'ftp://example.com/a.txt', 'local')
  await call('openFileUri', '::not-a-uri::', 'local')
  await call('openUrl', 'ftp://example.com/a.txt')
  await call('openUrl', '::not-a-uri::')
  await assert.rejects(
    call(
      'pathsExist',
      Array.from({ length: 129 }, () => 'C:\\a')
    ),
    /Invalid path existence batch/
  )
  const systemRootExists = await call('pathExists', 'C:\\Windows')
  assert.equal(systemRootExists, true)
  // Why direct invoke: the checks above travel the renderer gate; these pin
  // the native boundary itself for callers that bypass it.
  const nativeBatch = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke('poc_paths_exist', {
      paths: Array.from({ length: 129 }, () => 'C:\\a')
    }).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error: String(error) })
    )
  )
  assert.equal(nativeBatch.ok, false)
  assert.match(nativeBatch.error, /Invalid path existence batch/)
  const nativeCopy = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke('poc_copy_file', {
      srcPath: 'C:\\Windows',
      destPath: 'relative-dest.txt'
    }).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error: String(error) })
    )
  )
  assert.equal(nativeCopy.ok, false)
  assert.match(nativeCopy.error, /absolute paths/)
  await assertReadyHidden(page, root)
  const evidence = { at: new Date().toISOString() }
  await writeFile(
    join(root, '.cache', 'tauri-shell-open-ownership-check-latest.json'),
    JSON.stringify(evidence, null, 2)
  )
  console.log('Shell open ownership matches Electron against the live shell.')
} finally {
  for (const browser of connections) {
    await browser.close().catch(() => {})
  }
}
