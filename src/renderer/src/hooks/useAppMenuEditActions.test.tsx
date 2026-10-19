// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_MENU_EDIT_ACTION_EVENT } from '@/lib/app-menu-edit-actions'
import { useAppMenuEditActions } from './useAppMenuEditActions'

let listener: ((action: 'undo' | 'redo') => void) | null = null
const performNativeEditAction = vi.fn()

function Harness(): null {
  useAppMenuEditActions()
  return null
}

beforeEach(() => {
  listener = null
  performNativeEditAction.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: {
        onAppMenuEditAction: vi.fn((callback) => {
          listener = callback
          return () => {
            listener = null
          }
        }),
        performNativeEditAction
      }
    }
  })
})

afterEach(() => cleanup())

describe('useAppMenuEditActions', () => {
  it('falls back to native edit when no Orca surface claims the action', () => {
    render(<Harness />)

    act(() => listener?.('undo'))

    expect(performNativeEditAction).toHaveBeenCalledWith('undo')
  })

  it('does not run native edit after a surface claims the action', () => {
    const claim = (event: Event): void => event.preventDefault()
    window.addEventListener(APP_MENU_EDIT_ACTION_EVENT, claim)
    render(<Harness />)

    act(() => listener?.('redo'))

    window.removeEventListener(APP_MENU_EDIT_ACTION_EVENT, claim)
    expect(performNativeEditAction).not.toHaveBeenCalled()
  })
})
