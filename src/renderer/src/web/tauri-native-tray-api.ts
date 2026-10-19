import { i18n, translate } from '@/i18n/i18n'
import type { PreloadApi } from '../../../preload/api-types'
import { getBrowserPlatform } from './preload-api/web-storage'
import { invokeNative, isTauriNativeHost } from './tauri-native-host'

export type TauriTrayEnsureArgs = {
  isDev: boolean
  devLabel: string | null
  openLabel: string
  settingsLabel: string | null
  checkUpdatesLabel: string | null
  quitLabel: string
  activityWaiting: string
  activityWaitingSuffix: string
}

type WindowWithApi = Window & { api?: PreloadApi }

// Mirrors Electron deferred creation (ready-to-show plus a fallback): the
// renderer is already mounted here, so one short delay is enough.
const TRAY_ENSURE_DELAY_MS = 1200

let trayAttentionActive = false
let trayInstalled = false
let trayLanguageHookInstalled = false

export function readTauriTrayLabels(): Omit<TauriTrayEnsureArgs, 'isDev' | 'devLabel'> {
  return {
    openLabel: translate('tray.openOrca', 'Open Orca'),
    settingsLabel: translate('menu.settings', 'Settings'),
    checkUpdatesLabel: translate('menu.checkForUpdates', 'Check for Updates...'),
    quitLabel: translate('tray.quit', 'Quit'),
    activityWaiting: translate('tray.activityWaiting', 'Orca - activity waiting'),
    activityWaitingSuffix: translate('tray.activityWaitingSuffix', 'activity waiting')
  }
}

async function readTrayIdentity(): Promise<{ isDev: boolean; devLabel: string | null } | null> {
  try {
    const identity = await (window as unknown as WindowWithApi).api?.app.getIdentity()
    if (!identity) {
      return null
    }
    return { isDev: identity.isDev, devLabel: identity.devLabel }
  } catch {
    return null
  }
}

function isTrayPlatform(): boolean {
  const platform = getBrowserPlatform()
  return platform === 'win32' || platform === 'darwin'
}

export async function ensureTauriSystemTray(): Promise<boolean> {
  if (!isTauriNativeHost() || !isTrayPlatform()) {
    return false
  }
  // macOS carries the app-menu entries too so the two never drift.
  const extended = getBrowserPlatform() === 'darwin'
  const identity = await readTrayIdentity()
  const labels = readTauriTrayLabels()
  const args: TauriTrayEnsureArgs = {
    isDev: identity?.isDev ?? false,
    devLabel: identity?.devLabel ?? null,
    openLabel: labels.openLabel,
    settingsLabel: extended ? labels.settingsLabel : null,
    checkUpdatesLabel: extended ? labels.checkUpdatesLabel : null,
    quitLabel: labels.quitLabel,
    activityWaiting: labels.activityWaiting,
    activityWaitingSuffix: labels.activityWaitingSuffix
  }
  try {
    return await invokeNative<boolean>('poc_tray_ensure', { args })
  } catch {
    return false
  }
}

export function setTauriTrayAttention(active: boolean): void {
  // Why: the dedup latch must settle synchronously or rapid show/hide mis-dedupes.
  if (!isTauriNativeHost() || trayAttentionActive === active) {
    return
  }
  trayAttentionActive = active
  void invokeNative<boolean>('poc_tray_set_attention', { args: { active } }).catch(() => {})
}

export function resetTauriTrayAttentionForTest(): void {
  trayAttentionActive = false
  trayInstalled = false
  trayLanguageHookInstalled = false
}

export async function rebuildTauriSystemTray(): Promise<boolean> {
  if (!isTauriNativeHost() || !isTrayPlatform()) {
    return false
  }
  const identity = await readTrayIdentity()
  const labels = readTauriTrayLabels()
  const extended = getBrowserPlatform() === 'darwin'
  try {
    return await invokeNative<boolean>('poc_tray_rebuild', {
      args: {
        isDev: identity?.isDev ?? false,
        devLabel: identity?.devLabel ?? null,
        openLabel: labels.openLabel,
        settingsLabel: extended ? labels.settingsLabel : null,
        checkUpdatesLabel: extended ? labels.checkUpdatesLabel : null,
        quitLabel: labels.quitLabel,
        activityWaiting: labels.activityWaiting,
        activityWaitingSuffix: labels.activityWaitingSuffix
      } satisfies TauriTrayEnsureArgs
    })
  } catch {
    return false
  }
}

export async function setTauriTrayVisible(visible: boolean): Promise<boolean> {
  if (!isTauriNativeHost() || !isTrayPlatform()) {
    return false
  }
  if (visible) {
    return ensureTauriSystemTray()
  }
  try {
    return await invokeNative<boolean>('poc_tray_set_visible', { args: { visible } })
  } catch {
    return false
  }
}

// Runs after settings save; mirrors main-process settings.ts rebuilding the
// menu plus main-window-actions syncing the macOS visibility preference.
export async function syncTauriSystemTrayAfterSettingsSaved(settings: {
  showMenuBarIcon?: boolean
}): Promise<void> {
  if (!isTauriNativeHost() || !isTrayPlatform()) {
    return
  }
  await rebuildTauriSystemTray().catch(() => {})
  if (settings.showMenuBarIcon !== undefined) {
    await setTauriTrayVisible(settings.showMenuBarIcon).catch(() => {})
  }
}

function installTrayLanguageHook(): void {
  if (trayLanguageHookInstalled) {
    return
  }
  trayLanguageHookInstalled = true
  try {
    i18n.on('languageChanged', () => {
      void rebuildTauriSystemTray()
    })
  } catch {
    // An uninitialized i18n keeps English labels until the next ensure.
  }
}

export function installTauriSystemTray(): void {
  if (!isTauriNativeHost() || !isTrayPlatform() || trayInstalled) {
    return
  }
  trayInstalled = true
  installTrayLanguageHook()
  // A shown window has no pending attention; focus covers restore too.
  window.addEventListener('focus', () => {
    setTauriTrayAttention(false)
  })
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      setTauriTrayAttention(false)
    }
  })
  window.setTimeout(() => {
    void ensureTauriSystemTray()
  }, TRAY_ENSURE_DELAY_MS)
}
