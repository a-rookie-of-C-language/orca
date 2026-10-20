import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof that viewport geometry on the Tauri path reaches ConPTY
// like Electron's pty.resize: the shell itself must report the spawned size
// and the resized size through $Host.UI.RawUI.WindowSize, and the renderer
// bookkeeping (getSize) must agree. Refuses visible windows and foreign
// checkouts, and kills only its own pane.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
let page
let id

async function writeAccepted(text) {
  const accepted = await page.evaluate(
    (params) => window.api.pty.writeAccepted(params.id, params.text, 'driving'),
    { id, text }
  )
  assert.equal(accepted, true, 'The shell did not acknowledge the input.')
}

async function readRawUiSize(marker, cols, rows, attempts = 15) {
  // Why -f instead of +: PSReadLine splits +-joined lines into continuation
  // prompts on this narrow ConPTY, so the marker would never match one line.
  // Why poll instead of read once: the resize lands in ConPTY asynchronously,
  // so a probe sent right after resize can observe the old size. The marker
  // carries the attempt so a stale line never satisfies a later round.
  for (let attempt = 0; attempt < attempts; attempt++) {
    const tagged = `${marker}-${attempt}`
    await writeAccepted(
      `Write-Output ('viewport-${tagged} {0}x{1}' -f $Host.UI.RawUI.WindowSize.Width, $Host.UI.RawUI.WindowSize.Height)\r`
    )
    for (let poll = 0; poll < 10; poll++) {
      const snapshot = await page.evaluate((pid) => window.api.pty.getMainBufferSnapshot(pid), id)
      const match = snapshot?.data?.match(new RegExp(`viewport-${tagged} (\\d+)x(\\d+)`))
      if (match) {
        const size = { cols: Number(match[1]), rows: Number(match[2]) }
        if (size.cols === cols && size.rows === rows) {
          return size
        }
        break
      }
      await delay(100)
    }
  }
  assert.fail(`The shell never converged on ${cols}x${rows} for ${marker}.`)
}

try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const directory = await mkdtemp(join(root, '.cache', 'tauri-viewport-check-'))
  await mkdir(directory, { recursive: true })
  try {
    const terminal = await page.evaluate((options) => window.api.pty.spawn(options), {
      worktreeId: 'global-floating-terminal',
      cwd: directory,
      cols: 80,
      rows: 24,
      initiallyHidden: true,
      shellOverride: 'powershell.exe'
    })
    id = terminal.id
    const initial = await readRawUiSize('initial', 80, 24)
    assert.deepEqual(initial, { cols: 80, rows: 24 }, 'The spawned ConPTY size is wrong.')
    const initialReported = await page.evaluate((pid) => window.api.pty.getSize(pid), id)
    assert.deepEqual(initialReported, { cols: 80, rows: 24 }, 'getSize disagrees at spawn.')
    // Why: a bare resize frame is observe-only in the multiplex contract (same as
    // Electron's remote panes through the shared orcad host); only a claim makes
    // this stream authoritative and drives ConPTY, which is what visible panes do.
    await page.evaluate((pid) => window.api.pty.resize(pid, 100, 30), id)
    const observed = await readRawUiSize('observed', 80, 24)
    assert.deepEqual(observed, { cols: 80, rows: 24 }, 'A bare resize must not drive ConPTY.')
    const observedReported = await page.evaluate((pid) => window.api.pty.getSize(pid), id)
    assert.deepEqual(observedReported, { cols: 100, rows: 30 }, 'getSize disagrees after resize.')
    await page.evaluate((pid) => window.api.pty.claimViewport(pid, 100, 30), id)
    const claimed = await readRawUiSize('claimed', 100, 30)
    assert.deepEqual(claimed, { cols: 100, rows: 30 }, 'The viewport claim did not reach ConPTY.')
    const claimedReported = await page.evaluate((pid) => window.api.pty.getSize(pid), id)
    assert.deepEqual(claimedReported, { cols: 100, rows: 30 }, 'getSize disagrees after claim.')
    // Viewport claims keep the stream alive: the pane must still answer input.
    await page.evaluate((pid) => window.api.pty.claimViewport(pid, 120, 40), id)
    const reclaimed = await page.evaluate((pid) => window.api.pty.getSize(pid), id)
    assert.deepEqual(reclaimed, { cols: 120, rows: 40 }, 'claimViewport did not update getSize.')
    await page.evaluate((pid) => window.api.pty.reportGeometry(pid, 100, 30), id)
    const reported = await page.evaluate((pid) => window.api.pty.getSize(pid), id)
    assert.deepEqual(reported, { cols: 100, rows: 30 }, 'reportGeometry did not update getSize.')
    await writeAccepted(`Write-Output 'viewport-still-alive'\r`)
    let alive = false
    for (let attempt = 0; attempt < 100; attempt++) {
      const snapshot = await page.evaluate((pid) => window.api.pty.getMainBufferSnapshot(pid), id)
      if (snapshot?.data?.includes('viewport-still-alive')) {
        alive = true
        break
      }
      await delay(100)
    }
    assert.equal(alive, true, 'The pane stopped answering after viewport claims.')
    const evidence = {
      initial,
      observed,
      claimed,
      reclaimed,
      reported,
      alive,
      at: new Date().toISOString()
    }
    await writeFile(
      join(root, '.cache', 'tauri-viewport-check-latest.json'),
      JSON.stringify(evidence, null, 2)
    )
    console.log('Viewport claims drive ConPTY, bare resizes stay observe-only, bookkeeping agrees.')
  } finally {
    if (id) {
      await page.evaluate((pid) => window.api.pty.kill(pid).catch(() => {}), id).catch(() => {})
    }
    await rm(directory, { recursive: true, force: true })
  }
  await assertReadyHidden(page, root)
} finally {
  await Promise.all([...connections].map((browser) => browser.close().catch(() => {})))
}
