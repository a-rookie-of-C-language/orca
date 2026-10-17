import type { AppApi, PlatformApi } from '../../../preload/api/app-api'
import { getBrowserPlatform } from './preload-api/web-storage'
import { invokeNative, isTauriNativeHost } from './tauri-native-host'

type TauriNativePlatformInfo = Awaited<ReturnType<PlatformApi['get']>>
type TauriNativeAppIdentity = Awaited<ReturnType<AppApi['getIdentity']>>

async function readNativePlatformInfo(): Promise<TauriNativePlatformInfo> {
  return invokeNative<TauriNativePlatformInfo>('poc_platform_info')
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
      cachedNativePlatformInfo ??= {
        platform: getBrowserPlatform(),
        osRelease: '',
        arch: '',
        shell: '',
        displayServer: null
      }
      void readNativePlatformInfo().then((info) => {
        cachedNativePlatformInfo = info
      })
      return cachedNativePlatformInfo
    }
  }
}

export function createTauriNativeAppApi(): Partial<AppApi> {
  if (!isTauriNativeHost()) {
    return {}
  }
  return {
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
