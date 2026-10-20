import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for the plain-editable DOM context menu: under the Tauri
// host the gate is on, the model mirrors Electron's native edit template, and
// a real right-click shows the five-item menu. The press lands on a visible
// plain input when the workspace has one and Escape dismisses it untouched;
// otherwise a fixed-position input is injected (and removed below, so no
// workspace state is touched) and its Select-all item is clicked to prove the
// dispatch path. Also pins that the rich-markdown surface keeps its own menu.
// Refuses visible windows and foreign checkouts.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
let page
try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const gate = await page.evaluate(async () => {
    const model = await import('/src/components/editor/plain-editable-dom-context-menu-model.ts')
    const view = await import('/src/components/editor/plain-editable-dom-context-menu.tsx')
    return {
      tauriHost: typeof window.__TAURI_INTERNALS__?.invoke === 'function',
      gate: model.shouldUsePlainEditableDomContextMenu(),
      componentLoaded: typeof view.PlainEditableDomContextMenuHost === 'function',
      topLevel: model
        .buildPlainEditableDomContextMenuModel({ hasSelection: true, readOnly: false })
        .map((entry) => (entry.kind === 'separator' ? null : entry.label)),
      readOnlyCut: model.buildPlainEditableDomContextMenuModel({
        hasSelection: true,
        readOnly: true
      })[0],
      rejectsMarkdown: (() => {
        const prose = document.createElement('div')
        prose.className = 'tiptap'
        const input = document.createElement('input')
        prose.append(input)
        return model.findPlainEditableContextMenuTarget(input) === null
      })()
    }
  })
  assert.equal(gate.tauriHost, true, 'The renderer is not running under the Tauri host.')
  assert.equal(gate.gate, true, 'The DOM context menu gate is off under Tauri.')
  assert.equal(gate.componentLoaded, true, 'The DOM menu host failed to load.')
  assert.deepEqual(gate.topLevel, ['Cut', 'Copy', 'Paste', 'Paste as plain text', 'Select all'])
  assert.equal(gate.readOnlyCut?.disabled, true, 'Cut is not disabled on read-only targets.')
  assert.equal(gate.rejectsMarkdown, true, 'The plain menu claims the rich-markdown surface.')
  let box = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('input, textarea')]
    for (const element of candidates) {
      if (!(element instanceof HTMLElement)) {
        continue
      }
      if (element.closest('.tiptap, .xterm')) {
        continue
      }
      if (element instanceof HTMLInputElement) {
        if (
          !['text', 'search', 'password', 'url', 'tel', 'email', 'number'].includes(element.type)
        ) {
          continue
        }
        if (element.disabled || element.readOnly) {
          continue
        }
      } else if (element.disabled || element.readOnly) {
        continue
      }
      const rect = element.getBoundingClientRect()
      if (rect.width < 8 || rect.height < 8) {
        continue
      }
      if (
        rect.bottom < 0 ||
        rect.top > window.innerHeight ||
        rect.right < 0 ||
        rect.left > window.innerWidth
      ) {
        continue
      }
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    }
    return null
  })
  let injected = false
  if (!box) {
    box = await page.evaluate(() => {
      const input = document.createElement('input')
      input.type = 'text'
      input.value = 'probe'
      input.style.cssText = 'position:fixed;left:40px;top:40px;width:160px;height:28px;z-index:1'
      document.body.append(input)
      const rect = input.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })
    injected = true
  }
  await page.mouse.click(box.x, box.y, { button: 'right' })
  await page.waitForSelector('[data-testid="plain-editable-dom-context-menu"]', { timeout: 5000 })
  const items = await page.$$eval(
    '[data-testid="plain-editable-dom-context-menu"] [role="menuitem"]',
    (nodes) => nodes.map((node) => node.textContent ?? '')
  )
  assert.deepEqual(
    items.map((text) => text.trim()),
    ['Cut', 'Copy', 'Paste', 'Paste as plain text', 'Select all']
  )
  if (injected) {
    await page.click('[data-testid="plain-editable-dom-context-menu"] [data-edit="select-all"]')
  } else {
    await page.keyboard.press('Escape')
  }
  await page.waitForSelector('[data-testid="plain-editable-dom-context-menu"]', {
    state: 'detached',
    timeout: 5000
  })
  const ui = injected ? 'injected-menu-select-all' : 'menu-shown-dismissed'
  if (injected) {
    await page.evaluate(() => {
      document.querySelectorAll('input').forEach((node) => {
        if (node instanceof HTMLInputElement && node.value === 'probe') {
          node.remove()
        }
      })
    })
  }
  const evidence = { ...gate, ui, at: new Date().toISOString() }
  await writeFile(
    join(root, '.cache', 'tauri-plain-editable-menu-check.json'),
    `${JSON.stringify(evidence, null, 2)}\n`
  )
  console.log(`PLAIN-EDITABLE-MENU-CHECK ui=${ui} gate=${gate.gate}`)
} finally {
  for (const connection of connections) {
    await connection.close().catch(() => {})
  }
}
