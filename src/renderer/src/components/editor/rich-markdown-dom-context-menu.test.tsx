// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import {
  buildRichMarkdownDomContextMenuModel,
  shouldUseRichMarkdownDomContextMenu,
  type RichMarkdownDomMenuEntry
} from './rich-markdown-dom-context-menu-model'
import { RichMarkdownDomContextMenu } from './rich-markdown-dom-context-menu'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

const TABLE = `| A | B |
| --- | --- |
| a1 | b1 |
| a2 | b2 |
`

afterEach(cleanup)

function textPosition(editor: Editor, text: string): number {
  let position: number | null = null
  editor.state.doc.descendants((node, nodePosition) => {
    if (node.isText && node.text === text) {
      position = nodePosition
      return false
    }
    return true
  })
  if (position === null) {
    throw new Error(`Missing text: ${text}`)
  }
  return position
}

function createEditor(content: string): { editor: Editor; element: HTMLDivElement } {
  const element = document.createElement('div')
  document.body.append(element)
  // Why: happy-dom reports zero rects, which would fail the same in-scope
  // coordinate guard the Electron IPC path uses for multi-editor windows.
  const inScopeRect = {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 1000,
    bottom: 1000,
    width: 1000,
    height: 1000,
    toJSON: () => ({
      x: 0,
      y: 0,
      width: 1000,
      height: 1000,
      top: 0,
      right: 1000,
      bottom: 1000,
      left: 0
    })
  }
  element.getBoundingClientRect = () => inScopeRect
  const editor = new Editor({
    element,
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content,
    contentType: 'markdown'
  })
  return { editor, element }
}

function topLevelLabels(entries: RichMarkdownDomMenuEntry[]): (string | null)[] {
  return entries.map((entry) =>
    entry.kind === 'separator' ? null : entry.kind === 'submenu' ? entry.label : entry.label
  )
}

describe('rich markdown dom context menu gate', () => {
  it('stays off on plain desktop renderer builds', () => {
    expect(shouldUseRichMarkdownDomContextMenu()).toBe(false)
  })

  it('turns on under the Tauri native host', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke: vi.fn() }
    })
    try {
      expect(shouldUseRichMarkdownDomContextMenu()).toBe(true)
    } finally {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test stages and removes a Tauri host marker that the DOM type omits.
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    }
  })

  it('turns on for the paired web client', () => {
    Object.defineProperty(window, '__ORCA_WEB_CLIENT__', {
      configurable: true,
      value: true
    })
    try {
      expect(shouldUseRichMarkdownDomContextMenu()).toBe(true)
    } finally {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test stages and removes a web-client marker that the DOM type omits.
      delete (window as unknown as Record<string, unknown>).__ORCA_WEB_CLIENT__
    }
  })
})

describe('rich markdown dom context menu model', () => {
  it('mirrors the Electron template order without a table section outside tables', () => {
    expect(
      topLevelLabels(buildRichMarkdownDomContextMenuModel({ cellType: null, hasSelection: true }))
    ).toEqual([
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
  })

  it('adds an enabled table section for body cells', () => {
    const model = buildRichMarkdownDomContextMenuModel({ cellType: 'body', hasSelection: true })
    const table = model.find((entry) => entry.kind === 'submenu' && entry.label === 'Table')
    expect(table?.kind).toBe('submenu')
    if (table?.kind !== 'submenu') {
      return
    }
    expect(table.items.map((item) => (item.kind === 'separator' ? null : item.label))).toEqual([
      'Insert row above',
      'Insert row below',
      'Delete row',
      null,
      'Insert column left',
      'Insert column right',
      'Delete column',
      null,
      'Delete table'
    ])
    expect(table.items.every((item) => item.kind !== 'command' || !item.disabled)).toBe(true)
  })

  it('disables row removal actions for header cells like the native menu', () => {
    const model = buildRichMarkdownDomContextMenuModel({ cellType: 'header', hasSelection: true })
    const table = model.find((entry) => entry.kind === 'submenu' && entry.label === 'Table')
    if (table?.kind !== 'submenu') {
      throw new Error('Missing table submenu')
    }
    const disabledByLabel = new Map<string, boolean | undefined>()
    for (const item of table.items) {
      if (item.kind === 'command') {
        disabledByLabel.set(item.label, item.disabled)
      }
    }
    expect(disabledByLabel.get('Insert row above')).toBe(true)
    expect(disabledByLabel.get('Delete row')).toBe(true)
    expect(disabledByLabel.get('Insert row below')).toBeFalsy()
    expect(disabledByLabel.get('Insert column left')).toBeFalsy()
    expect(disabledByLabel.get('Delete table')).toBeFalsy()
  })

  it('disables cut and copy without a selection', () => {
    const model = buildRichMarkdownDomContextMenuModel({ cellType: null, hasSelection: false })
    const disabledByLabel = new Map<string, boolean | undefined>()
    for (const entry of model) {
      if (entry.kind === 'edit') {
        disabledByLabel.set(entry.label, entry.disabled)
      }
    }
    expect(disabledByLabel.get('Cut')).toBe(true)
    expect(disabledByLabel.get('Copy')).toBe(true)
    expect(disabledByLabel.get('Paste')).toBeFalsy()
  })
})

describe('rich markdown dom context menu component', () => {
  it('runs bold against the right-clicked selection', () => {
    const { editor, element } = createEditor('hello world')
    const view = render(
      <RichMarkdownDomContextMenu
        editor={editor}
        rootRef={{ current: element }}
        toggleLink={vi.fn()}
        pickImage={vi.fn()}
      />
    )
    try {
      const from = textPosition(editor, 'hello world')
      editor.commands.setTextSelection({ from, to: from + 'hello world'.length })
      vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ inside: -1, pos: from + 1 })
      fireEvent.contextMenu(editor.view.dom, { clientX: 50, clientY: 60 })
      expect(
        document.body.querySelector('[data-testid="rich-markdown-dom-context-menu"]')
      ).not.toBeNull()
      fireEvent.mouseEnter(document.body.querySelector('[data-submenu="Format"]')!)
      fireEvent.click(document.body.querySelector('[data-command="bold"]')!)
      expect(editor.getHTML()).toContain('<strong>')
      expect(
        document.body.querySelector('[data-testid="rich-markdown-dom-context-menu"]')
      ).toBeNull()
    } finally {
      view.unmount()
      editor.destroy()
      element.remove()
    }
  })

  it('routes table commands from the table submenu', () => {
    const { editor, element } = createEditor(TABLE)
    const view = render(
      <RichMarkdownDomContextMenu
        editor={editor}
        rootRef={{ current: element }}
        toggleLink={vi.fn()}
        pickImage={vi.fn()}
      />
    )
    try {
      vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({
        inside: -1,
        pos: textPosition(editor, 'b2')
      })
      const targetCell = element.querySelectorAll('td').item(3)
      fireEvent.contextMenu(targetCell, { clientX: 12, clientY: 34 })
      fireEvent.mouseEnter(document.body.querySelector('[data-submenu="Table"]')!)
      fireEvent.click(document.body.querySelector('[data-command="delete-row"]')!)
      expect(editor.state.doc.textContent).toContain('a1')
      expect(editor.state.doc.textContent).not.toContain('a2')
    } finally {
      view.unmount()
      editor.destroy()
      element.remove()
    }
  })

  it('marks header row actions disabled in the rendered table submenu', () => {
    const { editor, element } = createEditor(TABLE)
    const view = render(
      <RichMarkdownDomContextMenu
        editor={editor}
        rootRef={{ current: element }}
        toggleLink={vi.fn()}
        pickImage={vi.fn()}
      />
    )
    try {
      fireEvent.contextMenu(element.querySelector('th')!, { clientX: 8, clientY: 9 })
      fireEvent.mouseEnter(document.body.querySelector('[data-submenu="Table"]')!)
      expect(
        document.body
          .querySelector('[data-command="insert-row-above"]')
          ?.getAttribute('data-disabled')
      ).toBe('true')
      expect(
        document.body.querySelector('[data-command="delete-table"]')?.getAttribute('data-disabled')
      ).toBeNull()
    } finally {
      view.unmount()
      editor.destroy()
      element.remove()
    }
  })

  it('closes on escape without running a command', () => {
    const { editor, element } = createEditor('hello world')
    const view = render(
      <RichMarkdownDomContextMenu
        editor={editor}
        rootRef={{ current: element }}
        toggleLink={vi.fn()}
        pickImage={vi.fn()}
      />
    )
    try {
      fireEvent.contextMenu(editor.view.dom, { clientX: 50, clientY: 60 })
      expect(
        document.body.querySelector('[data-testid="rich-markdown-dom-context-menu"]')
      ).not.toBeNull()
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(
        document.body.querySelector('[data-testid="rich-markdown-dom-context-menu"]')
      ).toBeNull()
      expect(editor.getHTML()).not.toContain('<strong>')
    } finally {
      view.unmount()
      editor.destroy()
      element.remove()
    }
  })
})
