import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for main-window Force Reload: a plain reload revalidates
// (304 baseline), the native `poc_main_force_reload` command fetches the full
// document through CDP Page.reload with ignoreCache, and the Mod+Shift+R chord
// takes the same path through the renderer shortcut layer. The invoke that
// fires the reload is allowed to die with the execution context it destroys;
// the fresh-document token plus the reload navigation entry prove the reload
// either way. Refuses visible windows and foreign checkouts like the sibling
// checks.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()

function step(message) {
  console.log(`[main-force-reload-check] ${message}`)
}

async function navigationEntry(page) {
  return page.evaluate(() => {
    const entry = performance.getEntriesByType('navigation')[0]
    return entry
      ? {
          type: entry.type,
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize
        }
      : null
  })
}

async function invoke(page, command, args) {
  return page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, { args }),
    { command, args }
  )
}

// Why reload racing: Page.reload resolves once the reload is initiated, so the
// document load lands after the invoke returns; wait for it explicitly.
async function reloadAndWait(page, trigger) {
  // Why token, not startTime: PerformanceNavigationTiming.startTime is always
  // 0, so only a fresh document (token gone) plus a 'reload' entry proves it.
  const token = `fr-token-${Date.now().toString(36)}`
  await page.evaluate((value) => (window.__frToken = value), token)
  // Why tolerated: the reload destroys the execution context the invoke reply
  // travels on, so a successful trigger reads as a navigation race. A trigger
  // that never reached the host reloads nothing and fails on the token below.
  await trigger().catch((error) => {
    if (!/Execution context was destroyed/.test(String(error?.message ?? error))) {
      throw error
    }
  })
  await page.waitForLoadState('load', { timeout: 30000 })
  await assertReadyHidden(page, root)
  const survivor = await page.evaluate(() => window.__frToken)
  assert.equal(survivor, undefined, 'The document did not reload; the token survived.')
  const after = await navigationEntry(page)
  assert.ok(after, 'No navigation entry after the reload.')
  assert.equal(after.type, 'reload', 'The main window did not reload.')
  return { after }
}

let page
try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  step('renderer ready and hidden')

  // Why plain first: a conditional reload revalidates (304, headers only), so
  // its transferSize is the baseline a cache-bypassing reload must exceed.
  const viaPlain = await reloadAndWait(page, () => page.evaluate(() => window.location.reload()))
  step('plain reload reloaded the main window')

  const viaCommand = await reloadAndWait(page, () => invoke(page, 'poc_main_force_reload'))
  step('native force-reload command reloaded the main window')
  // Why full body: ignoreCache skips revalidation, so the document must come
  // back over the network in full, unlike the plain 304 above.
  assert.ok(
    viaCommand.after.transferSize >= viaCommand.after.encodedBodySize &&
      viaCommand.after.transferSize > viaPlain.after.transferSize,
    `Force reload did not bypass the cache: plain=${viaPlain.after.transferSize}, force=${viaCommand.after.transferSize}, body=${viaCommand.after.encodedBodySize}.`
  )
  step('force reload fetched the full document, plain reload revalidated')

  // Why trusted chord: the Tauri menu installs no real accelerator for Force
  // Reload, so Mod+Shift+R must be claimed by the renderer shortcut path
  // exactly like a local press.
  const viaChord = await reloadAndWait(page, () => page.keyboard.press('Control+Shift+R'))
  step('Mod+Shift+R chord reloaded the main window')

  await mkdir(join(root, '.cache'), { recursive: true })
  await writeFile(
    join(root, '.cache', 'tauri-main-force-reload-check-latest.json'),
    JSON.stringify({ viaPlain, viaCommand, viaChord }, null, 2)
  )
  step('evidence written')
} finally {
  for (const connection of connections) {
    await connection.close().catch(() => {})
  }
}
console.log('[main-force-reload-check] passed')
