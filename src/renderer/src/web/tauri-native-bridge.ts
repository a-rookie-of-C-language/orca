import type { PreloadApi } from '../../../preload/api-types'
import { invokeNative, isTauriNativeHost } from './tauri-native-host'
import { createTauriNativeNotificationsApi } from './tauri-native-notifications-api'
import {
  createTauriNativeAppNamespaceApi,
  createTauriNativePlatformNamespaceApi
} from './tauri-native-platform-app-api'
import { createTauriNativeShellApi } from './tauri-native-shell-api'

export { createTauriNativeFilesystemDropApi } from './tauri-native-filesystem-drop-api'
export { isTauriNativeHost } from './tauri-native-host'
export { createTauriNativeNotificationsApi } from './tauri-native-notifications-api'
export {
  createTauriNativeAppNamespaceApi,
  createTauriNativeAppApi,
  createTauriNativePlatformNamespaceApi,
  createTauriNativePlatformApi
} from './tauri-native-platform-app-api'
export { createTauriNativeShellApi } from './tauri-native-shell-api'
export { createTauriNativeUiApi } from './tauri-native-ui-api'

const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'])

function isElectronStyleDragRegion(path: EventTarget[]): boolean {
  for (const target of path) {
    if (!(target instanceof HTMLElement)) {
      continue
    }
    const region = getComputedStyle(target).getPropertyValue('-webkit-app-region').trim()
    if (region === 'no-drag') {
      return false
    }
    if (region === 'drag') {
      return !INTERACTIVE_TAGS.has(target.tagName)
    }
  }
  return false
}

export function installTauriWindowDragBridge(): void {
  if (
    !isTauriNativeHost() ||
    (!navigator.userAgent.includes('Windows') && !navigator.userAgent.includes('Linux'))
  ) {
    return
  }
  document.addEventListener(
    'mousedown',
    (event) => {
      if (event.button !== 0 || event.detail !== 1) {
        return
      }
      if (!isElectronStyleDragRegion(event.composedPath())) {
        return
      }
      event.preventDefault()
      event.stopImmediatePropagation()
      void invokeNative('plugin:window|start_dragging')
    },
    true
  )
}

export function createTauriNativePreloadApi(): Partial<PreloadApi> {
  if (!isTauriNativeHost()) {
    return {}
  }
  const shell = createTauriNativeShellApi()
  const notifications = createTauriNativeNotificationsApi()
  return {
    ...(shell ? { shell } : {}),
    ...createTauriNativePlatformNamespaceApi(),
    ...createTauriNativeAppNamespaceApi(),
    ...(notifications ? { notifications } : {})
  }
}
