/** Electron presentation hooks for the host-neutral managed-server decision. */
import { createHostServerOnConnectDeps } from '../ssh/ssh-host-server-on-connect-wiring'
import { setSshHostServerStatus } from '../ssh/ssh-host-server-status'
import { getCurrentMainWindow } from './ssh-ipc-context'
import { broadcastSshState } from './ssh-renderer-broadcast'
import { connectInFlight } from './ssh-connect-attempt-registry'
import { startLegacyRelayBridge } from '../ssh/legacy-relay-bridge/legacy-relay-bridge-registry'
import type { HostServerOnConnectDeps, HostServerPhase } from '../ssh/ssh-host-server-on-connect'

export function hostServerOnConnectDeps(userDataPath: string): HostServerOnConnectDeps {
  return createHostServerOnConnectDeps(userDataPath, {
    startLegacyRelayBridge,
    progress: (targetId: string, phase: HostServerPhase) => {
      // A cancelled connect's decision keeps running; its progress must not revive the status.
      if (!connectInFlight.has(targetId)) {
        return
      }
      setSshHostServerStatus(targetId, { kind: 'setting-up', phase })
      broadcastSshState(getCurrentMainWindow, targetId, {
        targetId,
        status: 'connecting',
        error: null,
        reconnectAttempt: 0
      })
    }
  })
}
