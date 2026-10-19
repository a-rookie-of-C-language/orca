import type { BrowserWindow } from 'electron'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { connectionManager, portForwardManager } from './ssh-ipc-context'
import { broadcastPortForwards } from './ssh-renderer-broadcast'
import {
  persistSshPortForwards,
  persistSshPortForwardsWithUnrestored,
  restoreSshPortForwards
} from '../ssh/ssh-port-forward-persistence'

function dependencies() {
  if (!connectionManager || !portForwardManager || !getSshTargetRegistryStore()) {
    throw new Error('ssh_handlers_not_registered')
  }
  return {
    connectionManager,
    portForwardManager,
    store: getSshTargetRegistryStore()!
  }
}

// Why: after user add/remove/update the runtime manager is the source of truth — persist exactly its entries (unrestored ones handled by a separate helper).
export function persistPortForwards(targetId: string): void {
  persistSshPortForwards(dependencies(), targetId)
}

// Why: keep forwards that failed to restore in the persisted list so they retry on next reconnect instead of being silently dropped.
export function persistPortForwardsWithUnrestored(targetId: string): void {
  persistSshPortForwardsWithUnrestored(dependencies(), targetId)
}

export async function restorePortForwards(
  targetId: string,
  getMainWindow: () => BrowserWindow | null
): Promise<void> {
  await restoreSshPortForwards(dependencies(), targetId)
  broadcastPortForwards(getMainWindow, targetId)
}
