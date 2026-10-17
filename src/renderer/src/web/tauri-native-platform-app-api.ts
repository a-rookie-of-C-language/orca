import type { PreloadApi } from '../../../preload/api-types'
import type { AppApi, PlatformApi } from '../../../preload/api/app-api'
import { createWebAppApi } from './preload-api/web-app-api'
import { getBrowserPlatform } from './preload-api/web-storage'
import { invokeNative, isTauriNativeHost } from './tauri-native-host'

type TauriNativePlatformInfo = Awaited<ReturnType<PlatformApi['get']>>
type TauriNativeAppIdentity = Awaited<ReturnType<AppApi['getIdentity']>>

async function readNativePlatformInfo(): Promise<TauriNativePlatformInfo> {
  return invokeNative<TauriNativePlatformInfo>('poc_platform_info')
}

function fallbackPlatformInfo(): TauriNativePlatformInfo {
  return {
    platform: getBrowserPlatform(),
    osRelease: '',
    arch: '',
    shell: '',
    displayServer: null
  }
}

let cachedNativePlatformInfo: TauriNativePlatformInfo | undefined

export function createTauriNativePlatformApi(): Partial<PlatformApi> {
  if (!isTauriNativeHost()) {
    return {}
  }
  void readNativePlatformInfo().then((info) => {
    cachedNativePlatformInfo = info
  })
  return {
    get: () => {
      cachedNativePlatformInfo ??= fallbackPlatformInfo()
      void readNativePlatformInfo().then((info) => {
        cachedNativePlatformInfo = info
      })
      return cachedNativePlatformInfo
    }
  }
}

export function createTauriNativePlatformNamespaceApi(): Pick<PreloadApi, 'platform'> {
  const api = createTauriNativePlatformApi()
  return {
    platform: {
      get: () => api.get?.() ?? fallbackPlatformInfo()
    }
  }
}

export function createTauriNativeAppApi(): Partial<AppApi> {
  if (!isTauriNativeHost()) {
    return {}
  }
  return {
    ...createWebAppApi().app,
    getIdentity: () => invokeNative<TauriNativeAppIdentity>('poc_app_identity'),
    reload: async () => {
      window.location.reload()
    },
    relaunch: async () => {
      window.location.reload()
    },
    restart: async () => {
      window.location.reload()
    }
  }
}

export function createTauriNativeAppNamespaceApi(): Pick<PreloadApi, 'app'> {
  const api = createTauriNativeAppApi()
  const fallback = createWebAppApi().app
  if (!fallback) {
    throw new Error('The web app API fallback is unavailable.')
  }
  return {
    app: {
      ...fallback,
      getIdentity: api.getIdentity ?? fallback.getIdentity,
      reload: api.reload ?? fallback.reload,
      relaunch: api.relaunch ?? fallback.relaunch,
      restart: api.restart ?? fallback.restart
    }
  }
}
