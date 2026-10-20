// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  plugin: vi.fn(async () => null),
  listen: vi.fn(() => () => {}),
  nativeHost: true
}))
vi.mock('./tauri-native-host', () => ({
  isTauriNativeHost: () => native.nativeHost,
  invokeNative: native.invoke,
  invokePlugin: native.plugin,
  listenNative: native.listen
}))

vi.mock('@/i18n/i18n', () => ({
  i18n: { on: vi.fn() },
  translate: (_key: string, fallback: string) => fallback
}))

import {
  installTauriMinimizeToTrayNotice,
  notifyMinimizedToTrayOnce,
  resetTauriMinimizeToTrayNoticeForTest,
  syncTauriMinimizeToTray
} from './tauri-native-tray-close'

function stubUiApi(ui: unknown): void {
  ;(window as unknown as { api?: unknown }).api = { ui }
}

describe('syncTauriMinimizeToTray', () => {
  it('stays silent off the Tauri host', async () => {
    native.nativeHost = false
    await syncTauriMinimizeToTray(true)
    expect(native.invoke).not.toHaveBeenCalled()
  })

  it('pushes the flag to the native close handler', async () => {
    native.nativeHost = true
    native.invoke.mockResolvedValue(undefined)
    await syncTauriMinimizeToTray(true)
    expect(native.invoke).toHaveBeenCalledWith('poc_set_minimize_to_tray', {
      enabled: true
    })
  })

  it('swallows invoke failures so a settings save never throws', async () => {
    native.nativeHost = true
    native.invoke.mockRejectedValue(new Error('gone'))
    await expect(syncTauriMinimizeToTray(false)).resolves.toBeUndefined()
  })
})

describe('notifyMinimizedToTrayOnce', () => {
  const ui = { get: vi.fn(), set: vi.fn() }
  beforeEach(() => {
    native.nativeHost = true
    native.plugin.mockClear().mockResolvedValue(null)
    ui.get.mockReset()
    ui.set.mockReset().mockResolvedValue(undefined)
    stubUiApi(ui)
  })

  it('skips the notification when the persisted flag is already set', async () => {
    ui.get.mockResolvedValue({ trayMinimizeNoticeShown: true })
    await notifyMinimizedToTrayOnce()
    expect(native.plugin).not.toHaveBeenCalled()
    expect(ui.set).not.toHaveBeenCalled()
  })

  it('notifies once and persists the flag', async () => {
    ui.get.mockResolvedValue({})
    await notifyMinimizedToTrayOnce()
    expect(native.plugin).toHaveBeenCalledWith('notification', 'notify', {
      options: {
        title: 'Orca',
        body: 'Orca is still running in the system tray'
      }
    })
    expect(ui.set).toHaveBeenCalledWith({ trayMinimizeNoticeShown: true })
  })
})

describe('installTauriMinimizeToTrayNotice', () => {
  beforeEach(() => {
    resetTauriMinimizeToTrayNoticeForTest()
    native.listen.mockClear()
  })

  it('subscribes once for the Rust-emitted tray event', () => {
    installTauriMinimizeToTrayNotice()
    installTauriMinimizeToTrayNotice()
    expect(native.listen).toHaveBeenCalledTimes(1)
    expect(native.listen).toHaveBeenCalledWith('window:minimized-to-tray', expect.any(Function))
    resetTauriMinimizeToTrayNoticeForTest()
  })
})
