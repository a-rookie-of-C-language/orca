// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ invoke: vi.fn(), nativeHost: true }))
vi.mock('./tauri-native-host', () => ({
  isTauriNativeHost: () => native.nativeHost,
  invokeNative: native.invoke
}))

import { syncTauriAppearanceMenuAfterSettingsSaved } from './tauri-native-menu-appearance'

describe('tauri appearance menu sync', () => {
  beforeEach(() => {
    native.nativeHost = true
    native.invoke.mockReset()
    native.invoke.mockResolvedValue(undefined)
  })

  it('stays silent off the Tauri host', async () => {
    native.nativeHost = false

    await syncTauriAppearanceMenuAfterSettingsSaved({ statusBarVisible: false })

    expect(native.invoke).not.toHaveBeenCalled()
  })

  it('pushes present checks in one command', async () => {
    await syncTauriAppearanceMenuAfterSettingsSaved({
      statusBarVisible: false,
      showTasksButton: true,
      showTitlebarAppName: false
    })

    expect(native.invoke).toHaveBeenCalledTimes(1)
    expect(native.invoke).toHaveBeenCalledWith('poc_menu_set_appearance_checks', {
      args: { statusBarVisible: false, showTasksButton: true, showTitlebarAppName: false }
    })
  })

  it('ignores missing and non-boolean checks', async () => {
    await syncTauriAppearanceMenuAfterSettingsSaved({})
    await syncTauriAppearanceMenuAfterSettingsSaved({
      statusBarVisible: 'yes' as unknown as boolean
    })

    expect(native.invoke).not.toHaveBeenCalled()
  })
})
