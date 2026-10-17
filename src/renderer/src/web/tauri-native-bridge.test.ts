import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBrowserGlobals } from './web-preload-api-test-harness'

type Listener = { event: string; handler: (message: { payload: unknown }) => void }

function installTauriHost(): {
  invoke: ReturnType<typeof vi.fn>
  listeners: Listener[]
  emit: (event: string, payload: unknown) => void
  window: Window & typeof globalThis
} {
  const globals = installBrowserGlobals('Windows')
  const listeners: Listener[] = []
  const invoke = vi.fn((command: string) => {
    if (command === 'poc_is_maximized') {
      return Promise.resolve(false)
    }
    return Promise.resolve(null)
  })
  const event = {
    listen: vi.fn(
      async (name: string, handler: (message: { payload: unknown }) => void) => {
        listeners.push({ event: name, handler })
        return () => {
          const index = listeners.findIndex((listener) => listener.handler === handler)
          if (index !== -1) {
            listeners.splice(index, 1)
          }
        }
      }
    )
  }
  Object.assign(globals.window, {
    __TAURI_INTERNALS__: { invoke },
    __TAURI__: { event }
  })
  return {
    invoke,
    listeners,
    emit: (eventName, payload) => {
      for (const listener of listeners) {
        if (listener.event === eventName) {
          listener.handler({ payload })
        }
      }
    },
    window: globals.window
  }
}

describe('tauri native bridge', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps window controls and close handshake to Rust commands', async () => {
    const host = installTauriHost()
    const { createTauriNativeUiApi } = await import('./tauri-native-bridge')
    const ui = createTauriNativeUiApi()

    ui.minimize?.()
    ui.maximize?.()
    ui.requestClose?.()
    ui.confirmWindowClose?.()
    ui.popupMenu?.()

    expect(host.invoke.mock.calls.map(([command]) => command)).toEqual([
      'poc_minimize',
      'poc_toggle_maximize',
      'poc_request_close',
      'poc_confirm_close',
      'poc_popup_menu'
    ])
  })

  it('bridges maximize, fullscreen, close, and zoom events from Tauri', async () => {
    const host = installTauriHost()
    const { createTauriNativeUiApi } = await import('./tauri-native-bridge')
    const ui = createTauriNativeUiApi()
    const maximized = vi.fn()
    const fullscreen = vi.fn()
    const close = vi.fn()
    const zoom = vi.fn()

    ui.onMaximizeChanged?.(maximized)
    ui.onFullscreenChanged?.(fullscreen)
    ui.onWindowCloseRequested?.(close)
    ui.onTerminalZoom?.(zoom)
    await Promise.resolve()
    await Promise.resolve()

    host.emit('window:maximize-changed', true)
    host.emit('window:fullscreen-changed', true)
    host.emit('window:close-requested', { isQuitting: true, requestId: 4 })
    host.emit('terminal:zoom', 'out')

    expect(maximized).toHaveBeenCalledWith(true)
    expect(fullscreen).toHaveBeenCalledWith(true)
    expect(close).toHaveBeenCalledWith({ isQuitting: true })
    expect(zoom).toHaveBeenCalledWith('out')
  })

  it('applies UI zoom through the Chromium-equivalent scale factor', async () => {
    const host = installTauriHost()
    const { createTauriNativeUiApi } = await import('./tauri-native-bridge')
    const ui = createTauriNativeUiApi()

    ui.setZoomLevel?.(1)

    expect(ui.getZoomLevel?.()).toBe(1)
    expect(host.invoke).toHaveBeenCalledWith('poc_set_zoom', { scaleFactor: 1.2 })
  })

  it('validates dropped paths and reports bounded failures', async () => {
    const host = installTauriHost()
    host.invoke.mockImplementation((command: string) =>
      command === 'poc_validate_dropped_paths'
        ? Promise.resolve(['C:\\repo\\a.txt'])
        : Promise.resolve(null)
    )
    const { createTauriNativeFilesystemDropApi } = await import('./tauri-native-bridge')
    const fs = createTauriNativeFilesystemDropApi()

    await expect(
      fs?.prepareDroppedPaths?.({ paths: ['C:\\repo\\a.txt'], consumer: 'agent' })
    ).resolves.toEqual({ paths: ['C:\\repo\\a.txt'], failures: [] })
  })

  it('reports relative dropped paths as rejected', async () => {
    const host = installTauriHost()
    host.invoke.mockImplementation((command: string) =>
      command === 'poc_validate_dropped_paths'
        ? Promise.reject(new Error('invalid-path'))
        : Promise.resolve(null)
    )
    const { createTauriNativeFilesystemDropApi } = await import('./tauri-native-bridge')
    const fs = createTauriNativeFilesystemDropApi()

    await expect(
      fs?.prepareDroppedPaths?.({ paths: ['relative.txt'], consumer: 'agent' })
    ).resolves.toMatchObject({
      paths: [],
      failures: [{ target: 'rejected', reason: 'temp-copy-failed' }]
    })
  })
})
