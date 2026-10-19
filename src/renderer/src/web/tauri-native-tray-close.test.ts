// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ invoke: vi.fn(), nativeHost: true }))
vi.mock('./tauri-native-host', () => ({
  isTauriNativeHost: () => native.nativeHost,
  invokeNative: native.invoke
}))

import { syncTauriMinimizeToTray } from './tauri-native-tray-close'

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
