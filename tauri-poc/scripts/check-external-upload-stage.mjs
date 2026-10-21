import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertReadyHidden,
  connectDevelopmentRenderer
} from '../scripts/hidden-renderer-connection.mjs'

// Live Windows proof for staged external upload parity: the Rust stage command
// speaks the renderer camelCase wire shape (sourcePath, relativePath, byteLength)
// and a staged slice reads back through the chunk command. Refuses visible
// windows and foreign checkouts like the sibling checks.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
let page
const dir = mkdtempSync(join(root, '.cache', 'upload-stage-check-'))
const invoke = (command, args) =>
  page.evaluate((params) => window.__TAURI_INTERNALS__.invoke(params.command, params.args), {
    command,
    args
  })
try {
  writeFileSync(join(dir, 'note.txt'), 'hello from tauri')
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const staged = await invoke('poc_stage_external_paths', {
    args: { sourcePaths: [join(dir, 'note.txt')] }
  })
  const source = staged.sources[0]
  assert.equal(
    source.sourcePath,
    join(dir, 'note.txt'),
    `wire: ${JSON.stringify(source).slice(0, 400)}`
  )
  assert.equal(
    source.entries[0].relativePath,
    '',
    `entry: ${JSON.stringify(source.entries[0]).slice(0, 400)}`
  )
  assert.equal(source.entries[0].byteLength, 16)
  assert.ok(source.source_path === undefined, 'snake source_path leaked')
  assert.ok(source.entries[0].relative_path === undefined, 'snake relative_path leaked')
  const chunk = await invoke('poc_read_external_file_chunk', {
    args: {
      sourceRootPath: join(dir, 'note.txt'),
      entryRelativePath: '',
      expected: {
        byteLength: 16,
        inode: source.entries[0].inode,
        deviceId: source.entries[0].deviceId,
        modifiedAtMs: source.entries[0].modifiedAtMs
      },
      offset: 0,
      length: 5
    }
  })
  assert.equal(chunk.byteLength, 5)
  await assertReadyHidden(page, root)
  console.log(JSON.stringify({ ok: true, at: new Date().toISOString() }))
} finally {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
  for (const browser of connections) {
    await browser.close().catch(() => {})
  }
}
