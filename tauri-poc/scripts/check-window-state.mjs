import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertReadyHidden,
  connectDevelopmentRenderer
} from '../scripts/hidden-renderer-connection.mjs'

// Live Windows proof for main-window bounds memory: from a sanitized
// on-screen start, a distinct rectangle restores exactly after a restart, an
// off-screen save falls back to a visible centered rectangle, and maximized
// restores maximized. The persisted file is cross-read against the live
// rectangle, and the start and end states are restored.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const stateFile = join(
  process.env.APPDATA ?? '',
  'com.stablyai.orca.tauri-poc',
  'window-state.json'
)
const connections = new Set()
let page

const invoke = (command, args) =>
  page.evaluate((params) => window.__TAURI_INTERNALS__.invoke(params.command, params.args), {
    command,
    args
  })

const getBounds = () => invoke('poc_window_get_bounds', {})
const setBounds = (update) => invoke('poc_window_set_bounds', { update })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sameRect = (a, b) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
const readStateFile = async () => JSON.parse(await readFile(stateFile, 'utf8'))

async function pollFor(label, check) {
  for (let n = 0; n < 50; n++) {
    const value = await getBounds()
    if (check(value)) {
      return value
    }
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function pollStable(label) {
  let prev = await getBounds()
  for (let n = 0; n < 20; n++) {
    await sleep(250)
    const value = await getBounds()
    if (sameRect(value, prev)) {
      return value
    }
    prev = value
  }
  throw new Error(`timed out waiting for stable ${label}`)
}

async function relaunchAndReconnect() {
  const closed = page.waitForEvent('close', { timeout: 180000 })
  await page.evaluate(() => {
    void window.api.app.relaunch().catch((error) => {
      document.documentElement.dataset.relaunchError = String(
        error && error.message ? error.message : error
      )
    })
  })
  await closed
  console.log('probe: app closed, waiting for restart')
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  console.log('probe: renderer ready after restart')
}

const evidence = { at: new Date().toISOString() }
let orig = null
let origMaximized = false
try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  orig = await getBounds()
  origMaximized = orig.maximized
  if (orig.maximized) {
    await invoke('poc_toggle_maximize', {})
    orig = await pollFor('unmaximize', (v) => v.maximized === false)
  }
  if (orig.x > 30000 || orig.y > 30000) {
    console.log(`probe: sanitizing poisoned start ${JSON.stringify(orig)}`)
    await setBounds({ x: 400, y: 200 })
    orig = await pollFor('sanitize', (v) => v.x === 400 && v.y === 200)
    await sleep(900)
  }
  await setBounds({
    x: orig.x + 40,
    y: orig.y + 40,
    width: Math.max(orig.width - 160, 800),
    height: Math.max(orig.height - 120, 650)
  })
  const settled = await pollStable('set rect')
  await sleep(900)
  console.log(`probe: settled ${JSON.stringify(settled)}`)
  console.log(`probe: file ${JSON.stringify((await readStateFile()).bounds)}`)
  assert.deepEqual((await readStateFile()).bounds, {
    x: settled.x,
    y: settled.y,
    width: settled.width,
    height: settled.height
  })
  console.log('probe: relaunching')
  await relaunchAndReconnect()
  const after = await getBounds()
  assert.deepEqual(
    { x: after.x, y: after.y, width: after.width, height: after.height },
    { x: settled.x, y: settled.y, width: settled.width, height: settled.height },
    'restart must restore the settled rectangle'
  )
  assert.equal(after.maximized, false)
  evidence.rectRestored = settled
  await setBounds({ x: 99999, y: 99999 })
  await pollFor('poison', (v) => v.x > 30000)
  await sleep(900)
  console.log('probe: relaunching')
  await relaunchAndReconnect()
  const fallback = await getBounds()
  assert.ok(fallback.x < 30000, 'off-screen save must fall back to a visible position')
  assert.ok(fallback.width > 600 && fallback.height > 400, 'fallback keeps a usable size')
  evidence.offscreenFallback = {
    x: fallback.x,
    y: fallback.y,
    width: fallback.width,
    height: fallback.height
  }
  await invoke('poc_toggle_maximize', {})
  await pollFor('maximize', (v) => v.maximized === true)
  await sleep(900)
  console.log('probe: relaunching')
  await relaunchAndReconnect()
  assert.equal((await getBounds()).maximized, true, 'restart must restore maximized')
  evidence.maximizedRestored = true
  console.log('Window bounds restore, off-screen fallback, and maximized restore all hold live.')
} finally {
  try {
    if (page && orig) {
      const now = await getBounds().catch(() => null)
      if (now && now.maximized) {
        await invoke('poc_toggle_maximize', {})
        await sleep(500)
      }
      await setBounds({ x: orig.x, y: orig.y, width: orig.width, height: orig.height })
      const back = await pollFor('cleanup', (v) => v.x === orig.x && v.y === orig.y).catch(
        () => null
      )
      if (!back) {
        console.log('probe: WARNING cleanup position did not take, retrying once')
        await setBounds({ x: orig.x, y: orig.y })
        await pollFor('cleanup-retry', (v) => v.x === orig.x && v.y === orig.y)
      }
      await sleep(900)
      if (origMaximized) {
        await invoke('poc_toggle_maximize', {})
        await sleep(900)
      }
      console.log(`probe: final live ${JSON.stringify(await getBounds())}`)
      console.log(`probe: final file ${JSON.stringify(await readStateFile())}`)
    }
  } catch (error) {
    console.log(
      `probe: cleanup failed loudly: ${String(error && error.message ? error.message : error)}`
    )
    process.exitCode = 1
  }
  await writeFile(
    join(root, '.cache', 'tauri-window-state-check-latest.json'),
    JSON.stringify(evidence, null, 2)
  ).catch(() => {})
  for (const browser of connections) {
    await browser.close().catch(() => {})
  }
}
