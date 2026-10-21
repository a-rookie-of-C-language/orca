import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertReadyHidden,
  connectDevelopmentRenderer
} from '../scripts/hidden-renderer-connection.mjs'

// Live Windows proof for the doc-preview command surface: minting accepts the
// renderer camelCase owner for runtime and ssh grants (the wire shape the
// resolver unit tests pin), directory authorization is idempotent, unknown
// grants fail closed, and revoke removes the grant. The octet-stream serving
// fallback itself is unit-proven: top-level navigation to the custom scheme
// aborts from an http(s) page, so serving still needs the real guest flow.
// Refuses visible windows and foreign checkouts like the sibling checks.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
let page
const dir = mkdtempSync(join(root, '.cache', 'doc-preview-probe-'))
const invoke = (command, args) =>
  page.evaluate((params) => window.__TAURI_INTERNALS__.invoke(params.command, params.args), {
    command,
    args
  })
try {
  writeFileSync(join(dir, 'doc.md'), '# hello\n')
  writeFileSync(join(dir, 'notes.ts'), 'export const x = 1;\n')
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const grant = await invoke('poc_doc_preview_mint_grant', {
    request: {
      owner: {
        kind: 'runtime',
        environmentId: 'env-1',
        worktreeSelector: 'sel',
        worktreeRoot: dir
      },
      requestBase: dir,
      root: dir,
      entryRelativePath: 'doc.md',
      browserPageId: 'probe-doc-commands'
    }
  })
  assert.match(grant.grantId, /^[0-9a-f]{32}$/, `mint grant id: ${JSON.stringify(grant)}`)
  assert.ok(grant.url.indexOf(`orca-preview://${grant.grantId}/`) === 0, `mint url: ${grant.url}`)
  assert.equal(
    await invoke('poc_doc_preview_authorize_directory', {
      grantId: grant.grantId,
      relativePath: 'notes.ts'
    }),
    true
  )
  assert.equal(
    await invoke('poc_doc_preview_authorize_directory', {
      grantId: grant.grantId,
      relativePath: 'notes.ts'
    }),
    true
  )
  assert.equal(
    await invoke('poc_doc_preview_authorize_directory', {
      grantId: '0'.repeat(32),
      relativePath: 'notes.ts'
    }),
    false
  )
  const ssh = await invoke('poc_doc_preview_mint_grant', {
    request: {
      owner: { kind: 'ssh', connectionId: 'conn-1' },
      requestBase: '/docs',
      root: '/docs',
      entryRelativePath: 'index.md',
      browserPageId: 'probe-doc-commands-ssh'
    }
  })
  assert.match(ssh.grantId, /^[0-9a-f]{32}$/, `ssh mint: ${JSON.stringify(ssh)}`)
  assert.equal(await invoke('poc_doc_preview_revoke_grant', { grantId: ssh.grantId }), true)
  assert.equal(await invoke('poc_doc_preview_revoke_grant', { grantId: ssh.grantId }), false)
  assert.equal(await invoke('poc_doc_preview_revoke_grant', { grantId: grant.grantId }), true)
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
