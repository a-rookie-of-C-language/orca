import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const PANE_KEY = 'tab-1:01234567-89ab-4cde-8123-456789abcdef'

describe('tauri native notifications', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses native notification ids and routes notification clicks to the renderer UI', async () => {
    const actionListeners: ((payload: unknown) => void)[] = []
    const invoke = vi.fn((command: string) => {
      if (command === 'plugin:notification|notify') {
        return Promise.resolve(undefined)
      }
      return Promise.resolve(undefined)
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub supplies only the Tauri globals exercised by this unit test.
    const windowStub = new EventTarget() as unknown as Window & typeof globalThis
    Object.assign(windowStub, {
      __TAURI_INTERNALS__: { invoke },
      __TAURI__: {
        notification: {
          onAction: vi.fn(async (listener: (payload: unknown) => void) => {
            actionListeners.push(listener)
            return { unregister: async () => {} }
          })
        }
      },
      localStorage: { getItem: () => null }
    })
    vi.stubGlobal('window', windowStub)
    vi.stubGlobal('Notification', { permission: 'granted' })

    const { createTauriNativeNotificationsApi } = await import('./tauri-native-notifications-api')
    const { createTauriNativeUiApi } = await import('./tauri-native-ui-api')
    const notifications = createTauriNativeNotificationsApi()
    const ui = createTauriNativeUiApi()
    const focused = vi.fn()
    ui.onFocusTerminal?.(focused)

    const result = await notifications?.dispatch({
      source: 'terminal-bell',
      notificationId: 'terminal:1',
      worktreeId: 'repo-1::C:\\repo',
      paneKey: PANE_KEY,
      surface: 'terminal',
      terminalTitle: 'Build complete'
    })
    expect(result).toEqual({ delivered: true })
    expect(invoke).toHaveBeenCalledWith(
      'plugin:notification|notify',
      expect.objectContaining({ options: expect.objectContaining({ id: expect.any(Number) }) })
    )

    actionListeners[0]?.({
      actionId: 'tap',
      notification: { extra: { orcaNotificationId: 'terminal:1' } }
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(invoke).toHaveBeenCalledWith('poc_reveal_window', undefined)
    expect(focused).toHaveBeenCalledWith({
      tabId: 'tab-1',
      worktreeId: 'repo-1::C:\\repo',
      leafId: '01234567-89ab-4cde-8123-456789abcdef',
      ackPaneKeyOnSuccess: PANE_KEY,
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
  })

  it('forwards the native sound-gate reasons and plays validated sounds', async () => {
    let invokeSoundGateResult: unknown = { ok: false, path: null, reason: 'invalid-path' }
    const invoke = vi.fn((command: string) => {
      if (command === 'poc_notification_sound_path') {
        return Promise.resolve(invokeSoundGateResult)
      }
      return Promise.resolve(undefined)
    })
    const played: { src: string; volume: number }[] = []
    let playOutcome: 'resolve' | 'reject' = 'resolve'
    class MockAudio {
      src: string
      volume = 1
      constructor(src: string) {
        this.src = src
        played.push(this as unknown as { src: string; volume: number })
      }
      play(): Promise<void> {
        return playOutcome === 'resolve' ? Promise.resolve() : Promise.reject(new Error('nope'))
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub supplies only the Tauri globals exercised by this unit test.
    const windowStub = new EventTarget() as unknown as Window & typeof globalThis
    Object.assign(windowStub, {
      __TAURI_INTERNALS__: { invoke },
      localStorage: {
        getItem: () => JSON.stringify({ notifications: { customSoundPath: 'C:\\s\\tone.mp3' } })
      }
    })
    vi.stubGlobal('window', windowStub)
    vi.stubGlobal('Audio', MockAudio)
    vi.stubGlobal('Notification', { permission: 'granted' })

    const { createTauriNativeNotificationsApi } = await import('./tauri-native-notifications-api')
    const notifications = createTauriNativeNotificationsApi()

    await expect(notifications?.playSound?.({})).resolves.toEqual({
      played: false,
      reason: 'invalid-path'
    })
    expect(played).toEqual([])

    invokeSoundGateResult = { ok: false, path: null, reason: 'read-failed' }
    await expect(notifications?.playSound?.({})).resolves.toEqual({
      played: false,
      reason: 'read-failed'
    })

    invokeSoundGateResult = { ok: false, path: null, reason: 'too-large' }
    await expect(notifications?.playSound?.({})).resolves.toEqual({
      played: false,
      reason: 'too-large'
    })

    invokeSoundGateResult = { ok: true, path: 'C:\\s\\tone.mp3', reason: null }
    await expect(notifications?.playSound?.({ volume: 50 })).resolves.toEqual({ played: true })
    expect(played).toEqual([{ src: 'file:///C:/s/tone.mp3', volume: 0.5 }])

    playOutcome = 'reject'
    await expect(notifications?.playSound?.({})).resolves.toEqual({
      played: false,
      reason: 'playback-failed'
    })

    // Why playback-failed: Electron never throws from playSound, so a native
    // rejection resolves instead of surfacing as an unhandled rejection.
    invoke.mockRejectedValueOnce(new Error('native down'))
    await expect(notifications?.playSound?.({})).resolves.toEqual({
      played: false,
      reason: 'playback-failed'
    })
  })
})
