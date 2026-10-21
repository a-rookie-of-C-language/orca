import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertReadyHidden, connectDevelopmentRenderer } from './hidden-renderer-connection.mjs'

// Live Windows proof for the rich-markdown DOM context menu: under the Tauri
// host the gate is on, the model module loads in the real renderer bundle,
// and a real right-click on an open markdown editor shows the DOM menu and
// applies Bold. Skips the UI half when no markdown editor is open so the
// shared dev workspace is never disturbed. Refuses visible windows and
// foreign checkouts.
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const endpoint = process.env.ORCA_TAURI_CDP_ENDPOINT ?? 'http://127.0.0.1:9224'
const connections = new Set()
let page
try {
  page = await connectDevelopmentRenderer(endpoint, connections)
  await assertReadyHidden(page, root)
  const gate = await page.evaluate(async () => {
    const model = await import('/src/components/editor/rich-markdown-dom-context-menu-model.ts')
    const view = await import('/src/components/editor/rich-markdown-dom-context-menu.tsx')
    return {
      tauriHost: typeof window.__TAURI_INTERNALS__?.invoke === 'function',
      gate: model.shouldUseRichMarkdownDomContextMenu(),
      componentLoaded: typeof view.RichMarkdownDomContextMenu === 'function',
      topLevel: model
        .buildRichMarkdownDomContextMenuModel({ cellType: null, hasSelection: true })
        .map((entry) => (entry.kind === 'separator' ? null : entry.label)),
      bodyTable: model
        .buildRichMarkdownDomContextMenuModel({ cellType: 'body', hasSelection: true })
        .some(
          (entry) =>
            entry.kind === 'submenu' &&
            entry.items.some((item) => item.kind === 'command' && item.command === 'delete-table')
        )
    }
  })
  assert.equal(gate.tauriHost, true, 'The renderer is not running under the Tauri host.')
  assert.equal(gate.gate, true, 'The DOM context menu gate is off under Tauri.')
  assert.equal(gate.componentLoaded, true, 'The DOM menu component failed to load.')
  assert.deepEqual(gate.topLevel, [
    'Add link',
    null,
    'Format',
    'Paragraph',
    'Insert',
    null,
    'Cut',
    'Copy',
    'Paste',
    'Paste as plain text',
    'Select all'
  ])
  assert.equal(gate.bodyTable, true, 'The live model has no table section for body cells.')
  const editorBox = await page.evaluate(() => {
    const dom = document.querySelector('.tiptap')
    if (!dom) {
      return null
    }
    const rect = dom.getBoundingClientRect()
    return { x: rect.x + Math.min(200, rect.width / 2), y: rect.y + Math.min(60, rect.height / 2) }
  })
  let ui = 'skipped-no-open-markdown-editor'
  if (editorBox) {
    await page.mouse.click(editorBox.x, editorBox.y, { button: 'right' })
    await page.waitForSelector('[data-testid="rich-markdown-dom-context-menu"]', { timeout: 5000 })
    await page.hover('[data-submenu="Format"]')
    await page.click('[data-command="bold"]')
    await page.waitForSelector('[data-testid="rich-markdown-dom-context-menu"]', {
      state: 'detached',
      timeout: 5000
    })
    const boldApplied = await page.evaluate(() =>
      Boolean(document.querySelector('.tiptap strong, .tiptap b'))
    )
    assert.equal(boldApplied, true, 'Bold did not apply from the DOM context menu.')
    ui = 'menu-shown-bold-applied'
    await page.screenshot({ path: join(root, '.cache', 'tauri-dom-menu-check.png') })
  }
  const evidence = { ...gate, ui, at: new Date().toISOString() }
  await writeFile(
    join(root, '.cache', 'tauri-dom-menu-check.json'),
    `${JSON.stringify(evidence, null, 2)}\n`
  )
  console.log(`DOM-MENU-CHECK ui=${ui} gate=${gate.gate}`)
} finally {
  for (const connection of connections) {
    await connection.close().catch(() => {})
  }
}
