import { invokeNative, isTauriNativeHost } from './tauri-native-host'

export type TauriAppearanceMenuChecks = {
  statusBarVisible?: boolean
  showTasksButton?: boolean
  showAutomationsButton?: boolean
  showMobileButton?: boolean
  showTitlebarAppName?: boolean
}

const APPEARANCE_MENU_KEYS = [
  'statusBarVisible',
  'showTasksButton',
  'showAutomationsButton',
  'showMobileButton',
  'showTitlebarAppName'
] as const

// Runs after settings save; mirrors main-process settings.ts rebuilding the
// application menu so the View > Appearance checkboxes track state.
export async function syncTauriAppearanceMenuAfterSettingsSaved(
  settings: TauriAppearanceMenuChecks
): Promise<void> {
  if (!isTauriNativeHost()) {
    return
  }
  const args: Record<string, boolean> = {}
  for (const key of APPEARANCE_MENU_KEYS) {
    const checked = settings[key]
    if (typeof checked === 'boolean') {
      args[key] = checked
    }
  }
  if (Object.keys(args).length === 0) {
    return
  }
  await invokeNative('poc_menu_set_appearance_checks', { args }).catch(() => {})
}
