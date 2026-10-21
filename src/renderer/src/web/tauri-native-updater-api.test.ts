import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('tauri native updater menu check', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('runs a plain manual check when the native Help menu requests it', async () => {
    const invoke = vi.fn(async () => ({ state: 'idle' }))
    const listeners = new Map<string, (message: { payload: unknown }) => void>()
    vi.stubGlobal('window', {
      __TAURI_INTERNALS__: { invoke },
      __TAURI__: {
        event: {
          listen: vi.fn(async (event: string, handler: (message: { payload: unknown }) => void) => {
            listeners.set(event, handler)
            return () => {}
          })
        }
      }
    })

    const { createTauriNativeUpdaterApi } = await import('./tauri-native-updater-api')
    const api = createTauriNativeUpdaterApi()
    expect(api).toBeDefined()

    listeners.get('orca:tauri-ui:checkForUpdates')?.({ payload: undefined })
    await Promise.resolve()
    await Promise.resolve()

    expect(invoke).toHaveBeenCalledWith('poc_updater_check', {
      args: {
        userInitiated: true,
        includePrerelease: undefined,
        includePerfPrerelease: undefined,
        channel: undefined,
        targetTag: undefined
      }
    })
    vi.unstubAllGlobals()
  })

  it('forwards modifier-click variants from the native Help menu', async () => {
    const invoke = vi.fn(async () => ({ state: 'idle' }))
    const listeners = new Map<string, (message: { payload: unknown }) => void>()
    vi.stubGlobal('window', {
      __TAURI_INTERNALS__: { invoke },
      __TAURI__: {
        event: {
          listen: vi.fn(async (event: string, handler: (message: { payload: unknown }) => void) => {
            listeners.set(event, handler)
            return () => {}
          })
        }
      }
    })

    const { createTauriNativeUpdaterApi } = await import('./tauri-native-updater-api')
    const api = createTauriNativeUpdaterApi()
    expect(api).toBeDefined()

    listeners.get('orca:tauri-ui:checkForUpdates')?.({
      payload: { includePrerelease: true, includePerfPrerelease: false, localBuild: false }
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(invoke).toHaveBeenCalledWith('poc_updater_check', {
      args: {
        userInitiated: true,
        includePrerelease: true,
        includePerfPrerelease: false,
        channel: undefined,
        targetTag: undefined
      }
    })
    vi.unstubAllGlobals()
  })

  it('forwards pinned build jumps from the settings picker', async () => {
    const invoke = vi.fn(async () => ({ state: 'idle' }))
    vi.stubGlobal('window', {
      __TAURI_INTERNALS__: { invoke },
      __TAURI__: {
        event: {
          listen: vi.fn(async () => () => {})
        }
      }
    })

    const { createTauriNativeUpdaterApi } = await import('./tauri-native-updater-api')
    const api = createTauriNativeUpdaterApi()
    await api?.check({ channel: 'rc', targetTag: 'v1.4.220-rc.1' })

    expect(invoke).toHaveBeenCalledWith('poc_updater_check', {
      args: {
        userInitiated: true,
        includePrerelease: undefined,
        includePerfPrerelease: undefined,
        channel: 'rc',
        targetTag: 'v1.4.220-rc.1'
      }
    })
    vi.unstubAllGlobals()
  })
})
