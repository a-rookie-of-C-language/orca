// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../index'

function stubTauriHosts(invoke: (...args: unknown[]) => Promise<unknown>): void {
  ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke }
  ;(window as unknown as { api?: unknown }).api = {
    ui: { set: vi.fn(async () => {}) }
  }
}

function clearTauriHosts(): void {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  delete (window as unknown as { api?: unknown }).api
}

afterEach(() => {
  clearTauriHosts()
})

describe('status bar visibility menu sync', () => {
  it('pushes the new value to the native menu checks on the Tauri host', async () => {
    const invoke = vi.fn(async () => undefined)
    stubTauriHosts(invoke)

    useAppStore.getState().setStatusBarVisible(false)
    await Promise.resolve()

    expect(invoke).toHaveBeenCalledWith('poc_menu_set_appearance_checks', {
      args: { statusBarVisible: false }
    })
  })

  it('stays silent off the Tauri host', async () => {
    const invoke = vi.fn(async () => undefined)
    ;(window as unknown as { api?: unknown }).api = {
      ui: { set: vi.fn(async () => {}) }
    }

    useAppStore.getState().setStatusBarVisible(true)
    await Promise.resolve()

    expect(invoke).not.toHaveBeenCalled()
    clearTauriHosts()
  })
})
