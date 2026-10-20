import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
// Live Windows proof for the Workspace Space secondary window: async open without
// wedging Tauri IPC, create-then-reuse, zoom seeding onto the Space page, scratch
// analysis totals, progress events, snapshot caching, cancel and concurrency
// behavior, idle cancel, and malformed-input rejection. Refuses visible windows
// and foreign checkouts like the sibling checks.

// Why a tmpdir scratch tree: the scan only reads, but building it inside the
// shared workspace would pollute the dev checkout and risk scanning the
// checkout itself on a typo. Sizes are exact so the probe can assert totals.
async function buildTree(base, dirs, filesPerDir, size) {
  let expected = 0
  for (let d = 0; d < dirs; d++) {
    const dir = join(base, `d${d}`)
    await mkdir(dir, { recursive: true })
    const body = 'x'.repeat(size)
    for (let f = 0; f < filesPerDir; f++) {
      await writeFile(join(dir, `f${f}.txt`), body)
      expected += size
    }
  }
  return expected
}

function scanInput(base) {
  return {
    repos: [{ id: 'probe-repo', path: base, displayName: 'Probe' }],
    worktrees: [
      {
        id: 'probe-wt',
        repoId: 'probe-repo',
        displayName: 'Probe',
        path: base,
        branch: 'main',
        isMainWorktree: true,
        lastActivityAt: 0
      }
    ]
  }
}

async function invoke(page, command, payload) {
  return page.evaluate(
    ({ command, payload }) => window.__TAURI_INTERNALS__.invoke(command, payload),
    { command, payload }
  )
}

function step(message) {
  console.log(`[space-scan-check] ${message}`)
}

let page
const scratchRoots = []
try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  step('renderer ready and hidden')

  await page.evaluate(() => {
    window.__spaceProgress = []
    if (window.__spaceProgressObserverInstalled) {
      return
    }
    window.__spaceProgressObserverInstalled = true
    void window.__TAURI__.event
      .listen('workspace-space:progress', (incident) =>
        window.__spaceProgress.push(incident.payload)
      )
      .catch(() => {})
  })
  step('progress observer installed')

  await invoke(page, 'poc_workspace_space_open', {})
  await invoke(page, 'poc_workspace_space_open', {})
  step('space window opened twice (create then reuse)')
  await invoke(page, 'poc_set_zoom', { scaleFactor: 1.2, zoomLevel: 1 })
  const mainDpr = await page.evaluate(() => window.devicePixelRatio)
  const livePages = [...connections][0].contexts().flatMap((context) => context.pages())
  const space = livePages.find((candidate) => candidate.url().includes('space.html'))
  assert.ok(space, 'The Space window did not appear as a CDP target.')
  assert.equal(
    await space.evaluate(() => window.devicePixelRatio),
    mainDpr,
    'The Space window did not inherit the main-window zoom.'
  )
  step(`Space DPR matches main DPR (${mainDpr})`)

  const small = join(tmpdir(), `orca-space-probe-${Date.now().toString(36)}`)
  scratchRoots.push(small)
  const expectedSmall = await buildTree(small, 4, 5, 64)
  const first = await invoke(page, 'poc_workspace_space_analyze', { input: scanInput(small) })
  assert.equal(first?.ok, true, 'The scratch scan did not succeed.')
  const analysis = first.analysis
  assert.equal(analysis?.scannedWorktreeCount, 1, 'The scratch worktree was not scanned.')
  assert.equal(analysis?.unavailableWorktreeCount, 0, 'The scratch worktree reported unavailable.')
  const row = analysis?.worktrees?.[0]
  assert.equal(row?.status, 'ok', 'The scratch worktree row is not ok.')
  assert.ok(
    (row?.sizeBytes ?? -1) >= expectedSmall,
    `sizeBytes ${row?.sizeBytes} is below the created ${expectedSmall}.`
  )
  assert.ok(
    (analysis?.totalSizeBytes ?? -1) >= expectedSmall,
    'totalSizeBytes is below created bytes.'
  )
  step(`scratch scan ok, row size ${row?.sizeBytes} covers ${expectedSmall} created bytes`)

  const progress = await page.evaluate(() => window.__spaceProgress ?? [])
  assert.ok(progress.length >= 1, 'No scan progress events reached the renderer.')
  assert.ok(
    progress.some((entry) => entry?.state === 'running' && entry?.totalRepoCount === 1),
    'No running progress event named this scan.'
  )
  step(`${progress.length} progress events observed`)

  const cached = await invoke(page, 'poc_workspace_space_get_cached_analysis', {})
  assert.equal(
    cached?.totalSizeBytes,
    analysis?.totalSizeBytes,
    'The cached snapshot does not match this scan.'
  )
  step('snapshot cached under the dev profile')

  // Cancellation race: the scan walks thousands of files while the cancel
  // invoke round-trips on the main thread, so cancel usually wins; retry with
  // a bigger tree when the scan wins the race instead of asserting a tautology.
  let cancelled = null
  for (let round = 0; round < 3 && !cancelled; round++) {
    const big = join(tmpdir(), `orca-space-probe-big-${Date.now().toString(36)}-${round}`)
    scratchRoots.push(big)
    await buildTree(big, 30, 100, 128)
    const pending = invoke(page, 'poc_workspace_space_analyze', { input: scanInput(big) })
    await delay(50)
    const second = await invoke(page, 'poc_workspace_space_analyze', {
      input: scanInput(small)
    }).then(
      () => 'unexpected-success',
      (error) => String(error?.message ?? error)
    )
    const cancelWon = await invoke(page, 'poc_workspace_space_cancel', {})
    const settled = await pending
    if (
      second !== 'unexpected-success' &&
      /already running/.test(second) &&
      cancelWon === true &&
      settled?.cancelled === true
    ) {
      cancelled = { round, second }
    } else {
      step(
        `cancel race round ${round} lost the race (second=${second.slice(0, 60)}, cancel=${cancelWon}), retrying bigger`
      )
    }
  }
  assert.ok(cancelled, 'Cancellation never won the race in 3 rounds.')
  step(`concurrent scan refused, cancel won round ${cancelled.round}`)

  assert.equal(
    await invoke(page, 'poc_workspace_space_cancel', {}),
    false,
    'Cancel reports work with no scan running.'
  )
  await assert.rejects(
    invoke(page, 'poc_workspace_space_analyze', { input: { repos: [{ nope: true }] } }),
    /invalid Workspace Space scan input/
  )
  step('idle cancel is false, malformed input is rejected')

  await mkdir(join(root, '.cache'), { recursive: true })
  await writeFile(
    join(root, '.cache', 'tauri-space-scan-check-latest.json'),
    JSON.stringify(
      { expectedSmall, rowSizeBytes: row?.sizeBytes, progressEvents: progress.length, cancelled },
      null,
      2
    )
  )
  step('evidence written')
} finally {
  for (const base of scratchRoots) {
    await rm(base, { recursive: true, force: true }).catch(() => {})
  }
  for (const browser of connections) {
    await browser.close().catch(() => {})
  }
}
console.log('[space-scan-check] passed')
