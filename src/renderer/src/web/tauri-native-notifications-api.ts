import type { PreloadApi } from '../../../preload/api-types'
import type {
  NotificationDispatchResult,
  NotificationPermissionStatusResult,
  NotificationSoundResult
} from '../../../shared/notification-settings-types'
import { getBrowserPlatform } from './preload-api/web-storage'
import { invokeNative, invokePlugin, isTauriNativeHost } from './tauri-native-host'

/**
 * Tauri has no Electron main process, so native notifications are rendered
 * through the platform web notification API. The adapter still mirrors
 * Electron's result vocabulary so callers keep one contract.
 */
export function createTauriNativeNotificationsApi(): PreloadApi['notifications'] | undefined {
  if (!isTauriNativeHost()) {
    return undefined
  }
  const isSupported = typeof Notification !== 'undefined'
  return {
    getDesktopAwayState: async () => undefined,
    dispatch: async (args): Promise<NotificationDispatchResult> => {
      if (!isSupported) {
        return { delivered: false, reason: 'not-supported' }
      }
      const title = args.repoLabel ?? args.worktreeLabel ?? 'Orca'
      const body = buildNotificationBody(args)
      try {
        if (Notification.permission === 'default') {
          await Notification.requestPermission()
        }
        if (Notification.permission !== 'granted') {
          return { delivered: false, reason: 'blocked-by-system' }
        }
        new Notification(title, { body })
        return { delivered: true }
      } catch {
        return { delivered: false, reason: 'not-displayed' }
      }
    },
    dismiss: async () => ({ dismissed: 0 }),
    settleStructuredPrompts: async () => {},
    openSystemSettings: async () => {
      await invokePlugin('opener', 'open_url', {
        url: 'ms-settings:notifications',
        with: null
      }).catch(() => {})
    },
    getPermissionStatus: async (): Promise<NotificationPermissionStatusResult> => ({
      supported: isSupported,
      platform: getBrowserPlatform(),
      requested: isSupported && Notification.permission !== 'default'
    }),
    probeDelivery: async () => ({
      state: isSupported
        ? Notification.permission === 'granted'
          ? 'delivered'
          : Notification.permission === 'denied'
            ? 'blocked'
            : 'awaiting-decision'
        : 'unsupported',
      authoritative: false
    }),
    playSound: async (options): Promise<NotificationSoundResult> => {
      const configuredPath = readConfiguredNotificationSoundPath()
      if (!configuredPath) {
        return { played: false, reason: 'missing-path' }
      }
      const resolved = await invokeNative<{
        ok: boolean
        path: string | null
        reason?: NotificationSoundResult['reason']
      }>('poc_notification_sound_path', { args: { path: configuredPath } })
      if (!resolved.ok || !resolved.path) {
        return { played: false, reason: resolved.reason ?? 'read-failed' }
      }
      try {
        const audio = new Audio(pathToFileUrl(resolved.path))
        if (typeof options?.volume === 'number' && Number.isFinite(options.volume)) {
          audio.volume = Math.min(1, Math.max(0, options.volume / 100))
        }
        await audio.play()
        return { played: true }
      } catch {
        return { played: false, reason: 'playback-failed' }
      }
    }
  }
}

function buildNotificationBody(
  args: Parameters<PreloadApi['notifications']['dispatch']>[0]
): string {
  if (args.surface === 'agent-session') {
    return args.agentLastAssistantMessage ?? args.agentPrompt ?? ''
  }
  return args.terminalTitle ?? ''
}

function pathToFileUrl(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${encodeURI(prefixed)}`
}

function readConfiguredNotificationSoundPath(): string | null {
  try {
    const raw = window.localStorage.getItem('orca-settings')
    if (!raw) {
      return null
    }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }
    if (!('notifications' in parsed) || typeof parsed.notifications !== 'object') {
      return null
    }
    const notifications = parsed.notifications
    if (notifications === null || !('customSoundPath' in notifications)) {
      return null
    }
    const path = notifications.customSoundPath
    return typeof path === 'string' && path.trim() ? path : null
  } catch {
    return null
  }
}
