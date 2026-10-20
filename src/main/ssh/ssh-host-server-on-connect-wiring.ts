/** The live collaborators behind each connect's server decision. */
import { getAppEnvironment } from '../../shared/app-environment'
import {
  getManagedOrcadFenceEnvironmentId,
  managedOrcadServerName
} from '../../shared/managed-orcad-ssh-owner'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { findOrcadMigrationSourceCutoverForTarget } from '../ssh/orcad-migration-cutover-journal'
import { abandonOrcadConversion } from '../ssh/orcad-conversion-abandon'
import { retainOrcadMigrationSource } from '../ssh/orcad-migration-source-retention'
import { hasOrcadTemplate } from '../orcad/orcad-artifact-materializer'
import { managedServerUpdateDeps } from '../ssh/managed-server-update-deps'
import { ensureOrcadManagedTunnel } from '../ssh/orcad-managed-tunnel'
import { verifyOrcadManagedServing } from '../ssh/orcad-managed-serving-verify'
import { convertSshTargetToManagedOrcad } from '../ssh/orcad-runtime-conversion'
import {
  orcadMigrationDestinationFor,
  orcadServerRepositoriesFor
} from '../ssh/orcad-runtime-conversion-wiring'
import { createManagedOrcadEnvironment } from '../ssh/orcad-runtime-deployment'
import type { HostServerOnConnectDeps, HostServerPhase } from './ssh-host-server-on-connect'
import {
  censusSshHostRelaysBeforeSession,
  relayTerminalsOnConnect
} from '../ssh/ssh-host-relay-terminals-on-connect'
import { requireManagedOrcadInfrastructure } from '../ssh/orcad-managed-runtime-context'
import { censusHostRelayTerminalsFor } from '../ssh/ssh-host-relay-census-for-target'
import { trackSshHostServerEvent } from '../ssh/ssh-host-server-telemetry'
import { knownSshHostPlatform } from '../ssh/ssh-host-platform-memo'
import { knownOrcadTunnelTransport } from '../ssh/orcad-tunnel-transport-memo'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { releaseUnreachableOrcadSetup } from '../ssh/orcad-unreachable-setup-release'

export type HostServerOnConnectWiringHooks = {
  /** Called while a managed-server decision is in progress. */
  progress?: (targetId: string, phase: HostServerPhase) => void
  /** Keeps pre-migration relay panes alive while a legacy bridge is available. */
  startLegacyRelayBridge?: (targetId: string) => Promise<void>
}

/**
 * Builds the managed-server decision collaborators without depending on a desktop window.
 * Electron and Tauri provide the small presentation/legacy-bridge hooks separately.
 */
export function createHostServerOnConnectDeps(
  userDataPath: string,
  hooks: HostServerOnConnectWiringHooks = {}
): HostServerOnConnectDeps {
  const registry = getSshTargetRegistryStore()!
  const claims = registry.getOrcadRuntimeClaims()
  const store = registry.getOrcadMigrationSource()
  const appVersion = getAppEnvironment().getVersion()
  const isRegistered = (environmentId: string): boolean =>
    listEnvironments(userDataPath).some((entry) => entry.id === environmentId)
  return {
    // Why registered only: a fence whose server never registered is an unfinished setup, not a server.
    managedEnvironmentId: (target) => {
      const environmentId = getManagedOrcadFenceEnvironmentId(target)
      return environmentId && isRegistered(environmentId) ? environmentId : null
    },
    ensureTunnel: async (environmentId) => {
      await ensureOrcadManagedTunnel(userDataPath, environmentId)
    },
    ensureServing: (environmentId) => verifyOrcadManagedServing(userDataPath, environmentId),
    retainCommittedSource: (target) => {
      const head = findOrcadMigrationSourceCutoverForTarget(userDataPath, target.id)
      if (head?.phase === 'destination-committed') {
        retainOrcadMigrationSource(userDataPath, head.migrationId)
      }
    },
    hasTemplate: hasOrcadTemplate,
    recordedUnavailable: (target) =>
      target.managedServerUnavailable?.appVersion === appVersion
        ? target.managedServerUnavailable.reason
        : null,
    recordUnavailable: (target, reason) => {
      registry.updateTarget(target.id, { managedServerUnavailable: { reason, appVersion } })
    },
    ...managedServerUpdateDeps(userDataPath),
    isEmptyHost: (target) => {
      // An interrupted empty-host deploy passes its own claim, recorded by its provisioning intent.
      const environmentId = getManagedOrcadFenceEnvironmentId(target)
      return claims.preflight(
        target.id,
        environmentId
          ? { environmentId, recorded: target.orcadProvisioning !== undefined }
          : undefined
      ).claimable
    },
    relayTerminals: (target) =>
      relayTerminalsOnConnect({
        store,
        targetId: target.id,
        censusHost: async () =>
          censusSshHostRelaysBeforeSession(
            await requireManagedOrcadInfrastructure().connectionManager.connect(target),
            target.id
          )
      }),
    deploy: (target) =>
      createManagedOrcadEnvironment(userDataPath, {
        name: target.orcadProvisioning?.name ?? managedOrcadServerName(target),
        sshTargetId: target.id
      }),
    convert: async (target, hostProof) => {
      // COMPAT(legacy-relay-bridge): find the panes old relays still run before the tabs remount.
      if (hostProof?.bridged) {
        if (!hooks.startLegacyRelayBridge) {
          throw new Error('legacy_relay_bridge_unavailable')
        }
        await hooks.startLegacyRelayBridge(target.id)
      }
      const converted = await convertSshTargetToManagedOrcad(userDataPath, {
        sshTargetId: target.id,
        name: managedOrcadServerName(target),
        // The connect's own census already answered; a conversion before any session reuses it.
        censusHost: (host) =>
          hostProof ? Promise.resolve(hostProof) : censusHostRelayTerminalsFor(host)(),
        // Why no releaseDirectSession: a disconnect here would cancel the connect that asked for it.
        destinationFor: orcadMigrationDestinationFor,
        serverRepositoriesFor: orcadServerRepositoriesFor
      })
      if (converted.outcome === 'converted' || converted.outcome === 'refused') {
        // "Move anyway" covers one attempt; a later move, or a later delta, asks again.
        // Kept on a throw: verifyFence re-exports with it, so a held fence could never resume.
        registry.updateTarget(target.id, { managedServerLeaveBehind: undefined })
      }
      return converted
    },
    abandonDeploy: async (target) => {
      const environmentId =
        getManagedOrcadFenceEnvironmentId(target) ??
        getManagedOrcadFenceEnvironmentId(registry.getTarget(target.id))
      if (environmentId && !isRegistered(environmentId)) {
        claims.release(target.id, environmentId)
        await claims.flush()
      }
    },
    hasUnfinishedConversion: (target) => {
      const head = findOrcadMigrationSourceCutoverForTarget(userDataPath, target.id)
      return (
        head !== null &&
        !head.supersedesMigrationId &&
        (head.phase === 'source-fenced' || head.phase === 'destination-staged')
      )
    },
    abandonConversion: async (target) => {
      await abandonOrcadConversion({
        userDataPath,
        store,
        claims,
        targetId: target.id,
        destinationFor: orcadMigrationDestinationFor
      })
    },
    isFencedBeforeStaging: (target) =>
      findOrcadMigrationSourceCutoverForTarget(userDataPath, target.id)?.phase === 'source-fenced',
    releaseUnreachableSetup: (target) =>
      releaseUnreachableOrcadSetup({ userDataPath, claims, targetId: target.id }),
    // Read at report time: a deploy or conversion learns the platform while the decision runs.
    report: (target, event) =>
      trackSshHostServerEvent(
        event,
        knownSshHostPlatform(target.id),
        knownOrcadTunnelTransport(target.id)
      ),
    progress: (target, phase) => {
      hooks.progress?.(target.id, phase)
    }
  }
}
