// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('./tauri-native-host', () => ({
  isTauriNativeHost: () => true,
  invokeNative: native.invoke,
  listenNative: () => () => {}
}))

vi.mock('@/i18n/i18n', () => ({
  i18n: { on: vi.fn() },
  translate: (_key: string, fallback: string) => fallback
}))

const IDENTITY = { isDev: true, devLabel: 'main' }

function stubWindowApi(): void {
  ;(window as unknown as { api?: unknown }).api = {
    app: { getIdentity: vi.fn(async () => IDENTITY) }
  }
}

function stubPlatform(userAgent: string): void {
  vi.stubGlobal('navigator', { userAgent })
}

describe('tauri native tray api', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.unstubAllGlobals()
    native.invoke.mockReset()
    native.invoke.mockImplementation(async () => true)
    delete (window as unknown as { api?: unknown }).api
    const { resetTauriTrayAttentionForTest } = await import('./tauri-native-tray-api')
    resetTauriTrayAttentionForTest()
  })

  it('creates the tray with translated labels and dev identity on Windows', async () => {
    stubPlatform('Windows NT 10.0; Win64; x64')
    stubWindowApi()
    const { ensureTauriSystemTray } = await import('./tauri-native-tray-api')
    await expect(ensureTauriSystemTray()).resolves.toBe(true)
    expect(native.invoke).toHaveBeenCalledWith('poc_tray_ensure', {
      args: {
        isDev: true,
        devLabel: 'main',
        openLabel: 'Open Orca',
        settingsLabel: null,
        checkUpdatesLabel: null,
        quitLabel: 'Quit',
        activityWaiting: 'Orca - activity waiting',
        activityWaitingSuffix: 'activity waiting'
      }
    })
  })

  it('carries the app-menu entries on macOS', async () => {
    stubPlatform('Macintosh; Intel Mac OS X 10_15_7')
    stubWindowApi()
    const { ensureTauriSystemTray } = await import('./tauri-native-tray-api')
    await ensureTauriSystemTray()
    expect(native.invoke).toHaveBeenCalledWith('poc_tray_ensure', {
      args: expect.objectContaining({
        settingsLabel: 'Settings',
        checkUpdatesLabel: 'Check for Updates...'
      })
    })
  })

  it('stays quiet on Linux', async () => {
    stubPlatform('X11; Linux x86_64')
    stubWindowApi()
    const { ensureTauriSystemTray } = await import('./tauri-native-tray-api')
    await expect(ensureTauriSystemTray()).resolves.toBe(false)
    expect(native.invoke).not.toHaveBeenCalled()
  })

  it('dedups rapid attention flips', async () => {
    stubPlatform('Windows NT 10.0; Win64; x64')
    const { setTauriTrayAttention } = await import('./tauri-native-tray-api')
    setTauriTrayAttention(true)
    setTauriTrayAttention(true)
    expect(native.invoke).toHaveBeenCalledTimes(1)
    expect(native.invoke).toHaveBeenCalledWith('poc_tray_set_attention', {
      args: { active: true }
    })
    setTauriTrayAttention(false)
    expect(native.invoke).toHaveBeenCalledTimes(2)
  })

  it('rebuilds labels and toggles visibility', async () => {
    stubPlatform('Windows NT 10.0; Win64; x64')
    stubWindowApi()
    const { rebuildTauriSystemTray, setTauriTrayVisible } = await import('./tauri-native-tray-api')
    await rebuildTauriSystemTray()
    expect(native.invoke).toHaveBeenCalledWith(
      'poc_tray_rebuild',
      expect.objectContaining({ args: expect.objectContaining({ openLabel: 'Open Orca' }) })
    )
    native.invoke.mockClear()
    await setTauriTrayVisible(false)
    expect(native.invoke).toHaveBeenCalledWith('poc_tray_set_visible', {
      args: { visible: false }
    })
  })
})
