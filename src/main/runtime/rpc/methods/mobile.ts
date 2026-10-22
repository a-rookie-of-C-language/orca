// Why: the mobile IPC handlers serve the Electron renderer; the same contract has to reach
// Tauri/web clients, so the host's pairing surface is re-exposed here over the runtime RPC.
import { defineMethod } from '../core'
import type { RuntimeAccessGrant } from '../../../../shared/runtime-access-grants'
import type { DeviceEntry } from '../../device-entry'
import {
  getDefaultPairingAddress,
  getPairingNetworkInterfaces,
  type NetworkInterface
} from '../../pairing-network-interfaces'
import { encodeMobilePairingQr } from '../../mobile-pairing-qr'
import { getLastRelayStatus } from '../../mobile-cloud-relay/orcad-relay-status-store'
import {
  MobileDeviceIdParams,
  MobilePairingQrParams,
  MobileRuntimePairingUrlParams
} from '../../../../shared/rpc-contract/mobile-params'
import { NETWORK_EXPOSURE_FAILED_GUIDANCE } from '../../network-exposure-guidance'
import { resolveAdvertisedPairingHostname } from '../../pairing-endpoint'
import { classifyRemotePairingHostname } from '../../../../shared/remote-pairing-address'

function toRuntimeAccessGrant(device: DeviceEntry): RuntimeAccessGrant {
  return {
    deviceId: device.deviceId,
    name: device.name,
    createdAt: device.pairedAt,
    lastSeenAt: device.lastSeenAt > 0 ? device.lastSeenAt : null
  }
}

// Why: only an explicit "This computer only" pick skips the one-way widen, and only when the
// address it advertises really is loopback — every other reach still opts in.
function servesThisComputerOnly(reach: string | undefined, address: string): boolean {
  if (reach !== 'this-computer') {
    return false
  }
  const hostname = resolveAdvertisedPairingHostname(address)
  return hostname !== null && classifyRemotePairingHostname(hostname) === 'loopback'
}

export const MOBILE_METHODS = [
  defineMethod({
    name: 'mobile.listNetworkInterfaces',
    permission: 'workspace',
    params: null,
    handler: async (_params, ctx): Promise<{ interfaces: NetworkInterface[] }> => ({
      interfaces: await getPairingNetworkInterfaces(
        ctx.mobile?.getNetworkExposureBindHost() ?? '127.0.0.1'
      )
    })
  }),
  defineMethod({
    name: 'mobile.getPairingQR',
    permission: 'workspace',
    params: MobilePairingQrParams,
    handler: async (params, ctx) => {
      if (!ctx.mobile) {
        return { available: false as const }
      }
      const ip =
        params.address ??
        (await getDefaultPairingAddress(ctx.mobile.getNetworkExposureBindHost()))
      if (!ip && params.connectionMode === 'local-only') {
        return {
          available: false as const,
          reason: 'invalid_advertised_endpoint',
          guidance:
            'No reachable network address is available for pairing. Connect to Wi-Fi or Tailscale, or pick an address manually.'
        }
      }
      const offer = await ctx.mobile.createMobilePairingOffer({
        address: ip,
        connectionMode: params.connectionMode,
        rotate: params.rotate,
        name: `Mobile ${new Date().toLocaleDateString()}`
      })
      if (!offer.available) {
        return {
          available: false as const,
          reason: offer.reason,
          guidance: offer.guidance,
          ...(offer.relayFailure ? { relayFailure: offer.relayFailure } : {})
        }
      }
      const qr = await encodeMobilePairingQr(offer.pairingUrl)
      return {
        available: true as const,
        qrDataUrl: qr.ok ? qr.qrDataUrl : null,
        qrSize: qr.ok ? qr.qrSize : null,
        ...(!qr.ok ? { qrError: qr.reason } : {}),
        pairingUrl: offer.pairingUrl,
        endpoint: ip ? offer.endpoint : null,
        deviceId: offer.deviceId,
        connectionMode: offer.connectionMode
      }
    }
  }),
  defineMethod({
    name: 'mobile.getRuntimePairingUrl',
    permission: 'workspace',
    params: MobileRuntimePairingUrlParams,
    handler: async (params, ctx) => {
      if (!ctx.mobile) {
        return { available: false as const }
      }
      const ip =
        params.address ??
        (await getDefaultPairingAddress(ctx.mobile.getNetworkExposureBindHost()))
      if (!ip) {
        return { available: false as const }
      }
      const thisComputerOnly = servesThisComputerOnly(params.reach, ip)
      if (!thisComputerOnly) {
        try {
          await ctx.mobile.ensureNetworkExposure()
        } catch (error) {
          console.error('[mobile] Network exposure failed while creating pairing offer:', error)
          return {
            available: false as const,
            reason: 'network_exposure_failed' as const,
            guidance: NETWORK_EXPOSURE_FAILED_GUIDANCE
          }
        }
      }
      const offer = ctx.mobile.createPairingOffer({
        address: ip,
        rotate: params.rotate,
        name: `Runtime ${new Date().toLocaleDateString()}`,
        scope: 'runtime',
        reach: thisComputerOnly ? 'this-computer' : 'network'
      })
      if (!offer.available) {
        return { available: false as const }
      }
      return {
        available: true as const,
        pairingUrl: offer.pairingUrl,
        webClientUrl: offer.webClientUrl,
        endpoint: offer.endpoint,
        deviceId: offer.deviceId
      }
    }
  }),
  defineMethod({
    name: 'mobile.listDevices',
    permission: 'workspace',
    params: null,
    handler: (_params, ctx) => ({
      devices: (ctx.mobile?.listPairedDevices() ?? [])
        .filter((d) => d.scope === 'mobile' && d.lastSeenAt > 0)
        .map((d) => ({
          deviceId: d.deviceId,
          name: d.name,
          pairedAt: d.pairedAt,
          lastSeenAt: d.lastSeenAt
        }))
    })
  }),
  defineMethod({
    name: 'mobile.listRuntimeAccessGrants',
    permission: 'workspace',
    params: null,
    handler: (_params, ctx) => ({
      grants: (ctx.mobile?.listRuntimeAccessGrants() ?? [])
        .filter((d) => d.scope === 'runtime')
        .sort((a, b) => b.pairedAt - a.pairedAt)
        .map(toRuntimeAccessGrant)
    })
  }),
  defineMethod({
    name: 'mobile.revokeDevice',
    permission: 'workspace',
    params: MobileDeviceIdParams,
    handler: async (params, ctx) =>
      ctx.mobile ? { revoked: await ctx.mobile.revokeMobileDevice(params.deviceId) } : { revoked: false }
  }),
  defineMethod({
    name: 'mobile.revokeRuntimeAccess',
    permission: 'workspace',
    params: MobileDeviceIdParams,
    handler: (params, ctx) =>
      ctx.mobile ? { revoked: ctx.mobile.revokeRuntimeAccess(params.deviceId) } : { revoked: false }
  }),
  defineMethod({
    name: 'mobile.isWebSocketReady',
    permission: 'workspace',
    params: null,
    handler: (_params, ctx) => {
      const endpoint = ctx.mobile?.getWebSocketEndpoint() ?? null
      return { ready: endpoint !== null, endpoint }
    }
  }),
  defineMethod({
    name: 'mobile.getRelayStatus',
    permission: 'workspace',
    params: null,
    handler: () => getLastRelayStatus()
  })
]
