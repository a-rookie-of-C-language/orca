import { clearBrowserRoutePartitionStorageForEnvironment } from '../browser/browser-route-partition-storage-runtime'
import { retireBrowserRoutePartitionStorageForEnvironment } from '../browser/browser-route-partition-storage-retirement'
import type { RuntimeEnvironmentBrowserStorageCleanup } from '../ipc/runtime-environment-removal-cleanup'

/** Electron owns Chromium partition storage; the Node runtime deliberately does not import it. */
export const electronRuntimeEnvironmentBrowserStorage: RuntimeEnvironmentBrowserStorageCleanup = {
  clearStorage: clearBrowserRoutePartitionStorageForEnvironment,
  async retireStorage(options) {
    await retireBrowserRoutePartitionStorageForEnvironment(options)
  }
}
