/**
 * `orcad` owns the desktop's Relay host session when it doubles as the desktop
 * (the Tauri dev loop): it registers this host's keypair against the relay at
 * ORCA_RELAY_URL and answers `pairing.provisionRelay` for phones that arrive
 * over it. `ORCA_CLOUD_DEV_AUTH=1` swaps login.onorca.dev for the local
 * dev-auth issuer, and connectCurrent below auto-signs a profile in, so no
 * official account is required.
 */
import {
  connectCurrentOrcaProfile,
  getCurrentOrcaProfileAuthStatus
} from '../orca-profiles/profile-cloud-service'
import { getOrcaCloudAuthConfig } from '../orca-profiles/profile-cloud-auth-config'
import { DesktopRelayService } from '../runtime/mobile-cloud-relay/desktop-relay-service'
import { setLastRelayStatus } from '../runtime/mobile-cloud-relay/orcad-relay-status-store'
import { onOrcaCloudSessionInvalidated } from '../orca-profiles/profile-cloud-session-invalidation'
import {
  getOrcaCloudSignInProgress,
  onOrcaCloudSignInProgressChanged
} from '../orca-profiles/profile-cloud-sign-in-progress'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import type { MobileRelayPairingProvider } from '../runtime/runtime-rpc/runtime-rpc-pairing-types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

function pairingProviderFor(service: DesktopRelayService): MobileRelayPairingProvider {
  return {
    createPairingRelay: (relayDeviceId) => service.createPairingRelay(relayDeviceId),
    onDeviceRevokeQueued: (item) => service.onDeviceRevokeQueued(item),
    onDemandStateChanged: () => service.demandStateChanged(),
    getEndpoints: (context, params) => service.getEndpoints(context, params),
    provisionRelay: (context, params) => service.provisionRelay(context, params)
  }
}

export async function startOrcadRelayService(
  rpc: OrcaRuntimeRpcServer,
  runtime: OrcaRuntimeService,
  userDataPath: string
): Promise<DesktopRelayService | null> {
  const authConfig = getOrcaCloudAuthConfig()
  if (!authConfig.configured) {
    return null
  }
  // dev-auth has no real OAuth flow; sign a profile in locally so the session
  // exists before the first relay token exchange asks for an access token.
  if (process.env.ORCA_CLOUD_DEV_AUTH === '1') {
    const status = getCurrentOrcaProfileAuthStatus(userDataPath)
    if (status.state !== 'connected') {
      try {
        await connectCurrentOrcaProfile(userDataPath)
      } catch (error) {
        console.warn('[orcad] dev-auth connect failed:', error)
      }
    }
  }
  const service = new DesktopRelayService({
    authConfig: authConfig.config,
    userDataPath,
    appVersion: process.env.ORCA_APP_VERSION ?? '0.0.0-orcad',
    runtimeRpc: rpc,
    onStatus: (status, cellUrl) => {
      setLastRelayStatus(status, cellUrl)
      runtime.publishMobileRelayStatus(status, cellUrl)
    }
  })
  rpc.setMobileRelayPairingProvider(pairingProviderFor(service))
  service.start()

  // Why: the renderer's cached auth status goes stale when a background refresh revokes the
  // session or a sign-in flow advances; these events let the web client re-fetch on time.
  onOrcaCloudSessionInvalidated(() => runtime.publishOrcaProfileAuthStatusChanged())
  onOrcaCloudSignInProgressChanged(() =>
    runtime.publishOrcaProfileSignInProgress(getOrcaCloudSignInProgress())
  )

  return service
}
