import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { Store } from '../persistence'
import type { SshConnectionState, SshTarget } from '../../shared/ssh-types'
import { getPublicSshState } from '../runtime/public-ssh-state'
import { SshConnectionManager } from '../ssh/ssh-connection-manager'
import { SshConnectionStore } from '../ssh/ssh-connection-store'
import { SshPortForwardManager } from '../ssh/ssh-port-forward'
import {
  persistSshPortForwardsWithUnrestored,
  restoreSshPortForwards
} from '../ssh/ssh-port-forward-persistence'
import {
  installSshRuntimeCredentialBridge,
  requestSshRuntimeCredential
} from '../ssh/ssh-runtime-credential-bridge'
import {
  setSshConnectionManagerResolver,
  setSshTargetMutations,
  setSshTargetRegistryHandlers,
  setSshTargetRegistryStore,
  setSshPortForwardManagerResolver
} from '../ssh/ssh-target-registry'
import { resolveHostServerOnConnect } from '../ssh/ssh-host-server-on-connect'
import { createHostServerOnConnectDeps } from '../ssh/ssh-host-server-on-connect-wiring'
import {
  clearSshHostServerStatus,
  getSshHostServerStatus,
  setSshHostServerStatus
} from '../ssh/ssh-host-server-status'
import { unservedHostServerMessage, unservedServerStatus } from '../ssh/ssh-host-unserved-status'

function publicSshState(state: SshConnectionState): SshConnectionState {
  return getPublicSshState(state) ?? state
}

function notifySshState(runtime: OrcaRuntimeService, state: SshConnectionState): void {
  runtime.notifySshStateChanged(state.targetId, publicSshState(state))
}

function connectedState(
  manager: SshConnectionManager,
  targetId: string,
  managedServer: SshConnectionState['managedServer']
): SshConnectionState {
  return {
    ...(manager.getState(targetId) ?? {
      targetId,
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    }),
    targetId,
    status: 'connected',
    error: null,
    ...(managedServer ? { managedServer } : {})
  }
}

function setupState(
  manager: SshConnectionManager,
  targetId: string,
  phase: 'connecting' | 'deploying' | 'converting' | 'updating' | 'starting'
): SshConnectionState {
  const current = manager.getState(targetId)
  return {
    ...(current ?? {
      targetId,
      status: 'connecting',
      error: null,
      reconnectAttempt: 0
    }),
    targetId,
    status: 'connecting',
    error: null,
    managedServer: { kind: 'setting-up', phase }
  }
}

async function connectTargetWithManagedServer(
  target: SshTarget,
  manager: SshConnectionManager,
  runtime: OrcaRuntimeService,
  userDataPath: string,
  decisionTargets: Set<string>
): Promise<SshConnectionState> {
  decisionTargets.add(target.id)
  notifySshState(runtime, setupState(manager, target.id, 'connecting'))
  try {
    await manager.connect(target)
    const decision = await resolveHostServerOnConnect(
      target,
      createHostServerOnConnectDeps(userDataPath, {
        // Tauri has no Electron relay bridge yet. A legacy relay is therefore never reported as
        // managed; the decision below safely returns an actionable unserved status instead.
        progress: (targetId, phase) => {
          notifySshState(runtime, setupState(manager, targetId, phase))
        }
      })
    )

    if (decision.route === 'managed') {
      const managedServer = {
        kind: 'managed' as const,
        environmentId: decision.environmentId,
        ...(decision.update ? { update: decision.update } : {}),
        ...(decision.serving ? { serving: decision.serving } : {}),
        ...(decision.linked ? { linked: decision.linked } : {})
      }
      setSshHostServerStatus(target.id, managedServer)
      const state = connectedState(manager, target.id, managedServer)
      notifySshState(runtime, state)
      return publicSshState(state)
    }

    const managedServer = unservedServerStatus(decision)
    setSshHostServerStatus(target.id, managedServer)
    const state = {
      ...connectedState(manager, target.id, managedServer),
      status: 'error' as const,
      error: unservedHostServerMessage(decision)
    }
    notifySshState(runtime, state)
    await manager.disconnect(target.id)
    throw new Error(state.error)
  } catch (error) {
    // A setup exception must not leave a direct SSH transport looking connected without a server.
    if (manager.getState(target.id)?.status === 'connected') {
      await manager.disconnect(target.id).catch(() => {})
    }
    if (getSshHostServerStatus(target.id)?.kind === 'setting-up') {
      clearSshHostServerStatus(target.id)
    }
    throw error
  } finally {
    decisionTargets.delete(target.id)
  }
}

/**
 * Installs the SSH pieces that are safe to run in the Node-owned Tauri runtime.
 *
 * Tauri owns the profile target registry, the direct ssh2 transport, and the managed-server
 * decision. Legacy relay panes still need the Electron bridge, so an unserved decision fails
 * closed instead of claiming managed-server parity that Tauri cannot provide yet.
 */
export function startOrcadSsh(input: {
  runtime: OrcaRuntimeService
  store: Store
  userDataPath: string
  registerCleanup: (cleanup: OrcadRuntimeCleanup) => void
}): void {
  const { runtime, store, userDataPath, registerCleanup } = input
  const sshStore = new SshConnectionStore(store)
  installSshRuntimeCredentialBridge(runtime, registerCleanup)
  const portForwardManager = new SshPortForwardManager()
  const decisionTargets = new Set<string>()
  const connectInFlight = new Map<string, Promise<SshConnectionState>>()
  const portForwardPersistence = () => ({
    store: sshStore,
    connectionManager: manager,
    portForwardManager
  })
  const manager = new SshConnectionManager({
    onStateChange: (targetId, state) => {
      if (decisionTargets.has(targetId) && state.status === 'connected') {
        notifySshState(runtime, setupState(manager, targetId, 'connecting'))
      } else {
        notifySshState(runtime, state)
      }
      if (state.status === 'connected') {
        void restoreSshPortForwards(portForwardPersistence(), targetId)
          .catch((error) => {
            console.warn(`[ssh] Failed to restore port forwards for ${targetId}:`, error)
          })
          .finally(() => {
            runtime.notifySshPortForwardsChanged(
              targetId,
              portForwardManager.listForwards(targetId)
            )
          })
      } else if (state.status !== 'connecting') {
        // Forward listeners belong to the old transport. Keep their saved descriptions, then
        // release local ports so a reconnect can bind them again.
        void portForwardManager
          .removeAllForwards(targetId)
          .then(() => {
            persistSshPortForwardsWithUnrestored(portForwardPersistence(), targetId)
            runtime.notifySshPortForwardsChanged(
              targetId,
              portForwardManager.listForwards(targetId)
            )
          })
          .catch((error) => {
            console.warn(`[ssh] Failed to close port forwards for ${targetId}:`, error)
          })
      }
    },
    onCredentialRequest: (targetId, kind, detail, echo, signal) =>
      requestSshRuntimeCredential(targetId, kind, detail, echo, signal)
  })
  portForwardManager.setCallbacks({
    onForwardClosed: (entry, reason) => {
      if (reason.kind === 'unexpected-exit') {
        console.warn(
          `[ssh] Port forward ${entry.localPort} → ${entry.remoteHost}:${entry.remotePort} closed unexpectedly${
            reason.detail ? `: ${reason.detail}` : ''
          }`
        )
      }
      persistSshPortForwardsWithUnrestored(portForwardPersistence(), entry.connectionId)
      runtime.notifySshPortForwardsChanged(
        entry.connectionId,
        portForwardManager.listForwards(entry.connectionId)
      )
    }
  })

  setSshTargetRegistryStore(sshStore)
  setSshConnectionManagerResolver(() => manager)
  setSshPortForwardManagerResolver(() => portForwardManager)
  setSshTargetRegistryHandlers({
    connect: async (targetId) => {
      const target = sshStore.getTarget(targetId)
      if (!target) {
        throw new Error(`SSH target "${targetId}" not found`)
      }
      const existing = connectInFlight.get(targetId)
      if (existing) {
        return existing
      }
      const promise = connectTargetWithManagedServer(
        target,
        manager,
        runtime,
        userDataPath,
        decisionTargets
      )
      connectInFlight.set(targetId, promise)
      try {
        return await promise
      } finally {
        if (connectInFlight.get(targetId) === promise) {
          connectInFlight.delete(targetId)
        }
      }
    },
    getState: (targetId) => manager.getState(targetId) ?? undefined,
    disconnect: async (targetId) => {
      persistSshPortForwardsWithUnrestored(portForwardPersistence(), targetId)
      await portForwardManager.removeAllForwards(targetId)
      persistSshPortForwardsWithUnrestored(portForwardPersistence(), targetId)
      runtime.notifySshPortForwardsChanged(targetId, [])
      await manager.disconnect(targetId)
    }
  })
  setSshTargetMutations({
    add: (target) => {
      const added = sshStore.addTarget({ ...target, source: 'manual' })
      const repoReadoptions = sshStore.lastRepoReadoptions
      sshStore.lastRepoReadoptions = []
      return { target: added, repoReadoptions }
    },
    update: (targetId, updates) =>
      sshStore.updateTarget(targetId, { ...updates, source: 'manual' }),
    remove: async (targetId) => {
      persistSshPortForwardsWithUnrestored(portForwardPersistence(), targetId)
      await portForwardManager.removeAllForwards(targetId)
      persistSshPortForwardsWithUnrestored(portForwardPersistence(), targetId)
      runtime.notifySshPortForwardsChanged(targetId, [])
      await manager.disconnect(targetId)
      sshStore.removeTarget(targetId)
    }
  })

  registerCleanup(async () => {
    connectInFlight.clear()
    decisionTargets.clear()
    await manager.disconnectAll()
    setSshConnectionManagerResolver(null)
    setSshPortForwardManagerResolver(null)
    setSshTargetRegistryHandlers({ connect: null, getState: null, disconnect: null })
    setSshTargetMutations(null)
    setSshTargetRegistryStore(null)
  })
}
