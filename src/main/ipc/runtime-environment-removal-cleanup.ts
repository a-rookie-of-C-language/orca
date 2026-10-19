import { clearRuntimeEnvironmentCapabilityEvidence } from './runtime-environment-capability-evidence'
import { clearRuntimeEnvironmentManualDisconnect } from './runtime-environment-manual-disconnect'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import {
  forgetRemoteLayoutSnapshot,
  type RemoteLayoutSnapshotStore
} from '../remote-layout-snapshot'

/** What a removed server leaves in the profile. */
export type RemovedServerStore = RemoteLayoutSnapshotStore & {
  /** Drops the unlinked server's workspace session partition. */
  removeWorkspaceSessionHost: (hostId: ExecutionHostId) => void
}

export type RuntimeEnvironmentBrowserStorageClear = {
  clearedPartitions: string[]
  livePartitions: string[]
}

export type RuntimeEnvironmentBrowserStorageCleanup = {
  clearStorage: (environmentId: string) => Promise<RuntimeEnvironmentBrowserStorageClear>
  retireStorage: (args: {
    environmentId: string
    whenClientHostClosed: Promise<void>
    clearStorage: (environmentId: string) => Promise<RuntimeEnvironmentBrowserStorageClear>
    onError: (error: unknown) => void
  }) => Promise<void>
}

const inertBrowserStorageCleanup: RuntimeEnvironmentBrowserStorageCleanup = {
  clearStorage: async () => ({ clearedPartitions: [], livePartitions: [] }),
  retireStorage: async () => {}
}

let browserStorageCleanup = inertBrowserStorageCleanup

/** Installs the browser storage lifecycle owned by the active desktop host. */
export function setRuntimeEnvironmentBrowserStorageCleanup(
  next: RuntimeEnvironmentBrowserStorageCleanup | null
): void {
  browserStorageCleanup = next ?? inertBrowserStorageCleanup
}

/** Retires a removed server's client-side state; resolves once its transport is invalidated. */
export function retireRemovedRuntimeEnvironment(
  environmentId: string,
  invalidateTransport: (environmentId: string) => Promise<void> | void,
  store: RemovedServerStore
): Promise<void> {
  clearRuntimeEnvironmentCapabilityEvidence(environmentId)
  // Why: listings enumerate session partitions as known hosts, so a kept one names a dead server.
  store.removeWorkspaceSessionHost(toRuntimeExecutionHostId(environmentId))
  forgetRemoteLayoutSnapshot(store, environmentId)
  clearRuntimeEnvironmentManualDisconnect(environmentId)
  const retiring = Promise.resolve(invalidateTransport(environmentId))
  // Why: removal is an explicit lifecycle decision, so its client-hosted browser storage goes
  // too -- but only once the client host releases its partitions, or every one refuses as live.
  void browserStorageCleanup
    .retireStorage({
      environmentId,
      whenClientHostClosed: retiring,
      clearStorage: browserStorageCleanup.clearStorage,
      onError: (error) => {
        console.warn('[runtime-environments] browser partition storage clear failed:', error)
      }
    })
    .catch((error) => {
      console.warn('[runtime-environments] browser partition storage clear failed:', error)
    })
  return retiring
}
