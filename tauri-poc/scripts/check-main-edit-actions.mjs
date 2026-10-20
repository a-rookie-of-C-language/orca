import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for the menu edit actions: undo/redo clicks are
// display-only hints off macOS whose routing runs per-surface through the
// renderer, so the Tauri ui api runs execCommand on the focused editable,
// matching Electron's undo/redo roles. Typing may span several browser undo
// entries, so undo loops to empty and redo loops back to full instead of
// assuming one entry per word; the menu event path then proves one undo plus
// one menu redo round-trips through the shared hook. A scratch input outside
// the React root is borrowed and removed, so no workspace state is touched.
// Refuses visible windows and foreign checkouts like the sibling checks.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()

function step(message) {
  console.log(`[main-edit-actions-check] ${message}`)
}

async function inputValue(page) {
  return page.evaluate(() => document.getElementById('__tauriEditProbeInput')?.value ?? null)
}

async function nativeEdit(page, action) {
  await page.evaluate((name) => window.api.ui.performNativeEditAction(name), action)
}

let page
try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  step('renderer ready and hidden')

  // Why a scratch input: the hidden renderer is the live app UI, so borrow a
  // sibling input outside the React root and remove it afterwards.
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.id = '__tauriEditProbeInput'
    input.style.cssText = 'position:fixed;left:0;top:0;opacity:0;'
    document.body.appendChild(input)
    input.focus()
  })
  step('scratch input focused')
  await page.keyboard.type('hello')
  assert.equal(await inputValue(page), 'hello')
  step('typed into the scratch input')

  // Native per-surface routing: the Tauri ui api runs execCommand on the
  // focused editable, matching Electron's undo/redo roles.
  for (let round = 0; round < 10; round++) {
    if ((await inputValue(page)) === '') {
      break
    }
    await nativeEdit(page, 'undo')
  }
  assert.equal(await inputValue(page), '', 'Native undo did not revert the focused editable.')
  step('native undo reverted the scratch input')
  for (let round = 0; round < 10; round++) {
    if ((await inputValue(page)) === 'hello') {
      break
    }
    await nativeEdit(page, 'redo')
  }
  assert.equal(await inputValue(page), 'hello', 'Native redo did not restore the focused editable.')
  step('native redo restored the scratch input')

  // Full menu path: Rust emits orca:tauri-ui:appMenuEditAction on the custom
  // undo/redo click; the shared hook routes it to the same native edit.
  await nativeEdit(page, 'undo')
  const emitted = await page.evaluate(async () => {
    try {
      await window.__TAURI__.event.emit('orca:tauri-ui:appMenuEditAction', 'redo')
      return 'sent'
    } catch {
      return 'blocked'
    }
  })
  await page
    .waitForFunction(
      () => document.getElementById('__tauriEditProbeInput')?.value === 'hello',
      null,
      {
        timeout: 5000
      }
    )
    .catch(() => {})
  const afterEmit = await inputValue(page)
  assert.equal(emitted, 'sent', 'The frontend could not emit the menu edit event.')
  assert.equal(afterEmit, 'hello', 'The menu edit event never reached the focused editable.')
  step('menu edit event redid through the shared hook')

  await page.evaluate(() => document.getElementById('__tauriEditProbeInput')?.remove())
  await mkdir(join(root, '.cache'), { recursive: true })
  await writeFile(
    join(root, '.cache', 'tauri-main-edit-actions-check-latest.json'),
    JSON.stringify({ emitted, afterEmit }, null, 2)
  )
  step('evidence written, scratch input removed')
} finally {
  try {
    if (page) {
      await page
        .evaluate(() => document.getElementById('__tauriEditProbeInput')?.remove())
        .catch(() => {})
    }
  } catch {
    // Best effort cleanup.
  }
  for (const connection of connections) {
    await connection.close().catch(() => {})
  }
}
console.log('[main-edit-actions-check] passed')
