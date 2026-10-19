// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildPlainEditableDomContextMenuModel,
  findPlainEditableContextMenuTarget,
  initialPlainEditableDomMenuFocus,
  movePlainEditableDomMenuFocus,
  readPlainEditableTargetState,
  shouldUsePlainEditableDomContextMenu,
  type PlainEditableDomMenuEntry
} from './plain-editable-dom-context-menu-model'
import { PlainEditableDomContextMenuHost } from './plain-editable-dom-context-menu'

afterEach(cleanup)

function labels(entries: PlainEditableDomMenuEntry[]): string[] {
  return entries.map((entry) => (entry.kind === 'separator' ? '---' : entry.label))
}

function withTauriHost<T>(run: () => T): T {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: { invoke: vi.fn() }
  })
  try {
    return run()
  } finally {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test stages and removes a Tauri host marker that the DOM type omits.
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  }
}

describe('plain editable dom context menu gate', () => {
  it('stays off on plain desktop renderer builds', () => {
    expect(shouldUsePlainEditableDomContextMenu()).toBe(false)
  })

  it('turns on under the Tauri native host', () => {
    expect(withTauriHost(shouldUsePlainEditableDomContextMenu)).toBe(true)
  })

  it('turns on for the paired web client', () => {
    Object.defineProperty(window, '__ORCA_WEB_CLIENT__', {
      configurable: true,
      value: true
    })
    try {
      expect(shouldUsePlainEditableDomContextMenu()).toBe(true)
    } finally {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test stages and removes a web-client marker that the DOM type omits.
      delete (window as unknown as Record<string, unknown>).__ORCA_WEB_CLIENT__
    }
  })
})

describe('plain editable dom context menu model', () => {
  it('mirrors the Electron native edit template order', () => {
    expect(
      labels(buildPlainEditableDomContextMenuModel({ hasSelection: true, readOnly: false }))
    ).toEqual(['Cut', 'Copy', 'Paste', 'Paste as plain text', 'Select all'])
  })

  it('disables cut and copy without a selection', () => {
    const entries = buildPlainEditableDomContextMenuModel({ hasSelection: false, readOnly: false })
    expect(entries.map((entry) => (entry.kind === 'separator' ? false : entry.disabled))).toEqual([
      true,
      true,
      false,
      false,
      false
    ])
  })

  it('disables cut and both pastes on read-only targets', () => {
    const entries = buildPlainEditableDomContextMenuModel({ hasSelection: true, readOnly: true })
    expect(entries.map((entry) => (entry.kind === 'separator' ? false : entry.disabled))).toEqual([
      true,
      false,
      true,
      true,
      false
    ])
  })
})

describe('plain editable context menu target', () => {
  it('claims text inputs and textareas', () => {
    const input = document.createElement('input')
    input.type = 'text'
    const area = document.createElement('textarea')
    expect(findPlainEditableContextMenuTarget(input)).toBe(input)
    expect(findPlainEditableContextMenuTarget(area)).toBe(area)
  })

  it('ignores non-text inputs, disabled fields, and plain elements', () => {
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    const disabled = document.createElement('input')
    disabled.type = 'text'
    disabled.disabled = true
    expect(findPlainEditableContextMenuTarget(checkbox)).toBe(null)
    expect(findPlainEditableContextMenuTarget(disabled)).toBe(null)
    expect(findPlainEditableContextMenuTarget(document.createElement('div'))).toBe(null)
    expect(findPlainEditableContextMenuTarget(null)).toBe(null)
  })

  it('yields surfaces that own their menu', () => {
    const prose = document.createElement('div')
    prose.className = 'tiptap'
    const proseInput = document.createElement('input')
    proseInput.type = 'text'
    prose.append(proseInput)
    const terminal = document.createElement('div')
    terminal.className = 'xterm'
    const terminalInput = document.createElement('textarea')
    terminal.append(terminalInput)
    expect(findPlainEditableContextMenuTarget(proseInput)).toBe(null)
    expect(findPlainEditableContextMenuTarget(terminalInput)).toBe(null)
  })

  it('reads selection and read-only state from inputs', () => {
    const input = document.createElement('input')
    input.type = 'text'
    input.value = 'hello'
    document.body.append(input)
    try {
      input.setSelectionRange(1, 3)
      expect(readPlainEditableTargetState(input)).toEqual({ hasSelection: true, readOnly: false })
      input.readOnly = true
      expect(readPlainEditableTargetState(input)).toEqual({ hasSelection: true, readOnly: true })
    } finally {
      input.remove()
    }
  })
})

describe('plain editable dom menu focus', () => {
  it('starts on the first enabled entry and wraps past the ends', () => {
    const entries = buildPlainEditableDomContextMenuModel({ hasSelection: false, readOnly: false })
    expect(initialPlainEditableDomMenuFocus(entries)).toBe(2)
    expect(movePlainEditableDomMenuFocus({ entries, focus: 4, direction: 1 })).toBe(2)
    expect(movePlainEditableDomMenuFocus({ entries, focus: 2, direction: -1 })).toBe(4)
  })

  it('falls back to select-all when edits are disabled', () => {
    const entries = buildPlainEditableDomContextMenuModel({ hasSelection: false, readOnly: true })
    expect(initialPlainEditableDomMenuFocus(entries)).toBe(4)
    expect(movePlainEditableDomMenuFocus({ entries, focus: 4, direction: 1 })).toBe(4)
    expect(initialPlainEditableDomMenuFocus([])).toBe(null)
    expect(movePlainEditableDomMenuFocus({ entries: [], focus: 3, direction: 1 })).toBe(3)
  })
})

describe('plain editable dom context menu host', () => {
  it('opens on a plain input and closes on Escape', () => {
    withTauriHost(() => {
      render(<PlainEditableDomContextMenuHost />)
      const input = document.createElement('input')
      input.type = 'text'
      input.value = 'hello'
      document.body.append(input)
      try {
        fireEvent.contextMenu(input, { clientX: 40, clientY: 60 })
        const menu = document.querySelector('[data-testid="plain-editable-dom-context-menu"]')
        expect(menu).not.toBe(null)
        expect(menu?.querySelectorAll('[role="menuitem"]')).toHaveLength(5)
        fireEvent.keyDown(window, { key: 'Escape' })
        expect(document.querySelector('[data-testid="plain-editable-dom-context-menu"]')).toBe(null)
      } finally {
        input.remove()
      }
    })
  })

  it('stays closed on surfaces that own their menu', () => {
    withTauriHost(() => {
      render(<PlainEditableDomContextMenuHost />)
      const prose = document.createElement('div')
      prose.className = 'tiptap'
      const proseInput = document.createElement('input')
      proseInput.type = 'text'
      prose.append(proseInput)
      document.body.append(prose)
      try {
        fireEvent.contextMenu(proseInput, { clientX: 40, clientY: 60 })
        expect(document.querySelector('[data-testid="plain-editable-dom-context-menu"]')).toBe(null)
      } finally {
        prose.remove()
      }
    })
  })
})
