import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for minimize-to-tray parity: the renderer-drawn X hides
// (isMinimized stays false) instead of taskbar-minimizing when the setting is
// on, and the one-shot notice flag persists through the paired-host merge.
// Refuses visible windows and restores the prior setting and flag.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
let page

const invoke = (command, args) =>
  page.evaluate((params) => window.__TAURI_INTERNALS__.invoke(params.command, params.args), {
    command,
    args
  })

try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  assert.equal(
    await invoke('poc_is_minimized', {}),
    false,
    'background window must not start minimized'
  )
  await invoke('poc_hide_to_tray', {})
  assert.equal(
    await invoke('poc_is_minimized', {}),
    false,
    'poc_hide_to_tray must hide, not taskbar-minimize'
  )
  await assertReadyHidden(page, root)
  const origSettings = await page.evaluate(() => window.api.settings.get())
  const origUi = await page.evaluate(() => window.api.ui.get())
  const origTray = origSettings && origSettings.minimizeToTrayOnClose === true
  const origNotice = origUi && origUi.trayMinimizeNoticeShown === true
  try {
    if (!origTray) {
      await page.evaluate(() => window.api.settings.set({ minimizeToTrayOnClose: true }))
      await page.reload()
      await assertReadyHidden(page, root)
    }
    await page.evaluate(() => window.api.ui.set({ trayMinimizeNoticeShown: false }))
    await page.evaluate(() => window.api.ui.requestClose())
    let minimized = true
    let ui = null
    for (let n = 0; n < 50; n++) {
      minimized = await invoke('poc_is_minimized', {})
      ui = await page.evaluate(() => window.api.ui.get())
      if (minimized === false && ui && ui.trayMinimizeNoticeShown === true) {
        break
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    assert.equal(
      minimized,
      false,
      'requestClose with minimize-to-tray must hide, not taskbar-minimize'
    )
    assert.equal(
      ui && ui.trayMinimizeNoticeShown,
      true,
      'one-shot tray notice flag was not persisted'
    )
    await assertReadyHidden(page, root)
    const evidence = {
      hideNotMinimized: true,
      trayBranchHides: true,
      noticeFlagPersisted: true,
      origTray,
      origNotice,
      at: new Date().toISOString()
    }
    await writeFile(
      join(root, '.cache', 'tauri-minimize-tray-check-latest.json'),
      JSON.stringify(evidence, null, 2)
    )
    console.log('Minimize-to-tray hides and notifies once against the live shell.')
  } finally {
    await page
      .evaluate(
        (flags) =>
          window.api.settings
            .set({ minimizeToTrayOnClose: flags[0] })
            .then(() => window.api.ui.set({ trayMinimizeNoticeShown: flags[1] })),
        [origTray, origNotice]
      )
      .catch(() => {})
    await page.reload().catch(() => {})
    await assertReadyHidden(page, root).catch(() => {})
  }
} finally {
  for (const browser of connections) {
    await browser.close().catch(() => {})
  }
}
