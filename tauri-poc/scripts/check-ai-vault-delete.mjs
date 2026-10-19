import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for Agent Session History deletion on Tauri: the native
// OS-trash boundary refuses unapproved plans and trashes a real file, exactly
// like Electron's shell.trashItem path. Refuses visible windows and foreign
// checkouts, and cleans up its scratch directory when done.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
let page

const invoke = (plan) =>
  page.evaluate(
    (params) => window.__TAURI_INTERNALS__.invoke('poc_trash_ai_vault_session', params),
    { plan }
  )

async function expectRejected(plan, fragment) {
  let error = null
  try {
    await invoke(plan)
  } catch (caught) {
    error = caught
  }
  assert.ok(error, 'The unapproved delete plan was accepted.')
  assert.match(String(error), new RegExp(fragment), 'The rejection reason was wrong.')
}

try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const directory = await mkdtemp(join(root, '.cache', 'tauri-aivault-delete-check-'))
  await mkdir(directory, { recursive: true })
  try {
    const victim = join(directory, 'session-test.jsonl')
    await writeFile(victim, '{"role":"user","text":"probe"}\n')
    const plan = {
      allowed: true,
      agent: 'codex',
      resolvedPath: victim,
      removals: [{ path: victim, kind: 'file', roots: [directory] }]
    }
    // Why: rejection probes run first while the file still exists, because a
    // missing path is idempotent by design and skips the roots check.
    await expectRejected({ ...plan, allowed: false }, 'not approved')
    await expectRejected({ ...plan, allowed: true, resolvedPath: victim, removals: [] }, 'no paths')
    await expectRejected(
      {
        allowed: true,
        agent: 'codex',
        resolvedPath: join(directory, 'other.jsonl'),
        removals: [{ path: victim, kind: 'file', roots: [directory] }]
      },
      'does not contain its transcript path'
    )
    await expectRejected(
      {
        allowed: true,
        agent: 'codex',
        resolvedPath: victim,
        removals: [{ path: victim, kind: 'file', roots: [join(directory, 'elsewhere')] }]
      },
      'outside approved roots'
    )
    assert.equal(existsSync(victim), true, 'The probe file went missing before the trash step.')
    await invoke(plan)
    assert.equal(existsSync(victim), false, 'The session file was not trashed.')
    // Trashing is idempotent: a missing path resolves instead of failing.
    await invoke(plan)
    const evidence = { rejections: 4, trashed: true, at: new Date().toISOString() }
    await writeFile(
      join(root, '.cache', 'tauri-ai-vault-delete-check-latest.json'),
      JSON.stringify(evidence, null, 2)
    )
    console.log('Session delete refuses bad plans and trashes through the native OS boundary.')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
  await assertReadyHidden(page, root)
} finally {
  await Promise.all([...connections].map((browser) => browser.close().catch(() => {})))
}
