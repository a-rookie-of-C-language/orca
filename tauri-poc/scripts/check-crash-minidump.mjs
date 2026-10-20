import assert from 'node:assert/strict'
import { copyFile, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for minidump capture parity: seed a renderer error, copy
// the real WebView2 Crashpad dump into a temp dir (the dump_directory test
// seam), capture it onto the report, prove the claim-once pairing with a
// second capture, then dismiss the seed and delete the temp dir.
// Refuses visible windows and leaves no report or temp dir behind.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
let page

const invoke = (command, args) =>
  page.evaluate((params) => window.__TAURI_INTERNALS__.invoke(params.command, params.args), {
    command,
    args
  })

const realDump = String.raw`C:\Users\hzz\AppData\Local\com.stablyai.orca.tauri-poc\EBWebView\Crashpad\reports\ebe38ddb-e449-4b0f-b1a4-493e11c982b8.dmp`

let tmp = null
let seedId = null
try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const seed = await invoke('poc_crash_reports_record_renderer_error', {
    args: {
      boundaryId: `minidump-check-${Date.now()}`,
      surface: 'app-root',
      errorName: 'ProbeError',
      errorMessage: 'minidump capture check'
    }
  })
  assert.equal(seed.ok, true, `seed failed: ${JSON.stringify(seed)}`)
  assert.equal(seed.deduped, false, 'seed was deduped')
  seedId = seed.report.id
  tmp = await mkdtemp(join(tmpdir(), 'minidump-check-'))
  const probeDump = join(tmp, 'probe.dmp')
  await copyFile(realDump, probeDump)
  // copyFile preserves the stale source mtime, so touch it: the recency gate
  // is the behavior under test, not the copy.
  const freshAt = new Date()
  await utimes(probeDump, freshAt, freshAt)
  try {
    const captured = await invoke('poc_crash_reports_capture_minidump', {
      args: { reportId: seedId, crashedAtMs: Date.now(), dumpDirectory: tmp }
    })
    assert.equal(captured.ok, true, `capture failed: ${JSON.stringify(captured)}`)
    const details = captured.report.details
    assert.equal(details.minidumpStatus, 'captured')
    assert.ok(
      String(details.minidumpPath).endsWith('probe.dmp'),
      `wrong dump path: ${JSON.stringify(details.minidumpPath)}`
    )
    assert.ok(details.minidumpProcessType, 'missing minidump process type')
    const again = await invoke('poc_crash_reports_capture_minidump', {
      args: { reportId: seedId, crashedAtMs: Date.now(), dumpDirectory: tmp }
    })
    assert.equal(again.ok, false, `re-capture must miss the claimed dump: ${JSON.stringify(again)}`)
    await assertReadyHidden(page, root)
    const evidence = {
      minidumpStatus: details.minidumpStatus,
      minidumpProcessType: details.minidumpProcessType,
      claimOnce: true,
      at: new Date().toISOString()
    }
    await writeFile(
      join(root, '.cache', 'tauri-crash-minidump-check-latest.json'),
      JSON.stringify(evidence, null, 2)
    )
    console.log('Minidump capture pairs the WebView2 dump against the live shell.')
  } finally {
    if (seedId) {
      const dismissed = await invoke('poc_crash_reports_dismiss', {
        args: { reportId: seedId }
      }).catch(() => null)
      assert.equal(dismissed && dismissed.status, 'dismissed', 'seed was not dismissed')
      const afterDismiss = await invoke('poc_crash_reports_get_requested', {
        args: { reportId: seedId }
      })
      assert.equal(
        afterDismiss && afterDismiss.status,
        'dismissed',
        'seed report should read back dismissed by id'
      )
    }
  }
} finally {
  for (const browser of connections) {
    await browser.close().catch(() => {})
  }
  if (tmp) {
    await rm(tmp, { recursive: true, force: true })
  }
}
