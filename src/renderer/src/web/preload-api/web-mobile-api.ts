import type { MobileApi } from '../../../../preload/api/mobile-api'
import type { MobileRelayStatusDetail } from '../../../../shared/mobile-relay-status'
import { callRuntimeResult } from './web-runtime-calls'
import { webRuntimeState } from './web-runtime-session'
import { onMobileRelayStatusChanged } from './web-mobile-relay-events'
import { noopUnsubscribe } from './web-storage'

export function createWebMobileApi(): { mobile: MobileApi } {
  return {
    mobile: {
      listNetworkInterfaces: () =>
        callRuntimeResult('mobile.listNetworkInterfaces', {}),
      getPairingQR: (args) => callRuntimeResult('mobile.getPairingQR', args ?? {}),
      // Why: firewall/network settings are desktop-OS concerns; the web client is served by the host,
      // which can answer status but cannot mutate the user's OS.
      getWindowsFirewallStatus: () => Promise.resolve({ supported: false }),
      repairWindowsFirewall: () => Promise.resolve({ ok: false, reason: 'unsupported' }),
      openWindowsNetworkSettings: () => Promise.resolve(false),
      getRuntimePairingUrl: (args) =>
        callRuntimeResult('mobile.getRuntimePairingUrl', args ?? {}),
      listDevices: () => callRuntimeResult('mobile.listDevices', {}),
      revokeDevice: (args) => callRuntimeResult('mobile.revokeDevice', args),
      listRuntimeAccessGrants: () =>
        callRuntimeResult('mobile.listRuntimeAccessGrants', {}),
      revokeRuntimeAccess: (args) =>
        callRuntimeResult('mobile.revokeRuntimeAccess', args),
      isWebSocketReady: () =>
        Promise.resolve({ ready: Boolean(webRuntimeState.activeEnvironment), endpoint: null }),
      getRelayStatus: () => callRuntimeResult<MobileRelayStatusDetail>('mobile.getRelayStatus'),
      onRelayStatusChanged: (callback) => onMobileRelayStatusChanged(callback),
      consumePendingUnpairedDeviceAuthFailure: () => Promise.resolve(false),
      onUnpairedDeviceAuthFailure: () => noopUnsubscribe
    }
  }
}
