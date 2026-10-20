import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { Store } from '../persistence'
import type { SshConnectionManager } from '../ssh/connection/ssh-connection-manager'
import { installLegacyRelayBridge } from '../ssh/legacy-relay/legacy-relay-bridge-registry'
import { terminalsBucket } from '../ssh/legacy-relay/legacy-relay-daily-activity'
import { knownSshHostPlatform } from '../ssh/ssh-host-platform-memo'
import { hostProps } from '../ssh/ssh-host-server-telemetry'
import { track } from '../telemetry/client'

// Why its own module: orcad-ssh.ts sits near the 300-line gate, and the bridge host is one
// cohesive collaborator (leases, connection, events, telemetry) worth naming on its own.
export function installOrcadLegacyRelayBridgeHost(args: {
  runtime: OrcaRuntimeService
  store: Store
  manager: SshConnectionManager
}): void {
  const { runtime, store, manager } = args
  installLegacyRelayBridge({
    leases: (targetId) => store.getSshRemotePtyLeases(targetId),
    retireLease: (targetId, relayPtyId, evidence) =>
      store.markSshRemotePtyLease(targetId, relayPtyId, evidence),
    recordStop: (targetId, relayPtyId, pendingKill) =>
      store.setSshRemotePtyLeasePendingKill(targetId, relayPtyId, pendingKill),
    connection: (targetId) => manager.getConnection(targetId) ?? null,
    remoteCli: {
      runtime: () => runtime,
      // Why strict true: the setting is opt-in, and an absent value is off.
      allowed: (targetId) => store.getSshTarget(targetId)?.allowRemoteCliControl === true
    },
    onPanesChanged: (panes) => runtime.notifyLegacyRelayBridgedPanesChanged(panes),
    onData: (ptyId, data) => runtime.notifyLegacyRelayBridgedPaneData(ptyId, data),
    onReplay: (ptyId, replay) => runtime.notifyLegacyRelayBridgedPaneReplay(ptyId, replay),
    onExit: (ptyId, code) => runtime.notifyLegacyRelayBridgedPaneExit(ptyId, code),
    report: (targetId, phase, terminals) => {
      try {
        track('ssh_host_server_legacy_relay_bridge', {
          phase,
          terminals: terminalsBucket(terminals),
          ...hostProps(knownSshHostPlatform(targetId))
        })
      } catch {
        // Telemetry never costs a terminal.
      }
    }
  })
}
