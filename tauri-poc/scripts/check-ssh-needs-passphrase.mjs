import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof that ssh.needsPassphrasePrompt answers from orcad instead
// of the retired web-client stub (`() => Promise.resolve(false)`). A fresh
// loopback target reports a real boolean false, while an empty targetId is
// rejected by the orcad SshTarget schema — the stub ignored its args and would
// have resolved false for both. Refuses visible windows and foreign checkouts,
// and always removes the probe target.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
let page
let targetId

try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const hasApi = await page.evaluate(() => Boolean(window.api?.ssh?.needsPassphrasePrompt))
  assert.equal(hasApi, true, 'The Tauri renderer has no window.api.ssh.needsPassphrasePrompt.')
  const added = await page.evaluate(() =>
    window.api.ssh.addTarget({
      target: { label: 'tauri-probe-passphrase', host: '127.0.0.1', port: 9, username: 'orcaprobe' }
    })
  )
  targetId = added?.target?.id ?? added?.id
  assert.ok(targetId, 'addTarget returned no target id.')
  const needsPrompt = await page.evaluate(
    (id) => window.api.ssh.needsPassphrasePrompt({ targetId: id }),
    targetId
  )
  assert.equal(needsPrompt, false, `Fresh loopback target reported needsPrompt=${needsPrompt}.`)
  let emptyError = null
  try {
    await page.evaluate(() => window.api.ssh.needsPassphrasePrompt({ targetId: '' }))
  } catch (error) {
    emptyError = String(error?.message ?? error)
  }
  assert.ok(emptyError, 'Empty targetId resolved; the retired stub ignored its args.')
  await page.evaluate((id) => window.api.ssh.removeTarget({ id }), targetId)
  targetId = null
  await assertReadyHidden(page, root)
  const evidence = { needsPrompt, emptyError, at: new Date().toISOString() }
  await writeFile(
    join(root, '.cache', 'tauri-ssh-needs-passphrase-check-latest.json'),
    JSON.stringify(evidence, null, 2)
  )
  console.log(`ssh.needsPassphrasePrompt answers from orcad (fresh target: ${needsPrompt}).`)
} finally {
  try {
    if (targetId) {
      await page?.evaluate((id) => window.api.ssh.removeTarget({ id }), targetId).catch(() => {})
    }
  } finally {
    await Promise.all([...connections].map((browser) => browser.close().catch(() => {})))
  }
}
