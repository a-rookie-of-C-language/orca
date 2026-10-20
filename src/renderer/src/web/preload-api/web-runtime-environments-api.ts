import { pairedRuntimeConnectionFromOffer } from '../../../../shared/paired-runtime-connection'
const pendingSubscriptions = new Map<string, AbortController>()
import type { PreloadApi } from '../../../../preload/api-types'
import { parseHostAccessLink } from '../../../../shared/remote-pairing-address'
import { verifyRemotePairingRuntimeStatus } from '../../../../shared/remote-pairing-verification'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { WslOrcadAccountNotAppliedEvent } from '../../../../shared/wsl-orcad-account-notice'
import { parseWebPairingInput } from '../web-pairing'
import { WebRuntimeClient } from '../web-runtime-client'
import { isWebRuntimeUnauthorizedError } from '../web-runtime-client-error'
import {
  createStoredWebRuntimeEnvironment,
  redactStoredWebRuntimeEnvironment,
  saveStoredWebRuntimeEnvironment
} from '../web-runtime-environment'
import { translate } from '@/i18n/i18n'
import { translateHostAccessLinkError } from '@/lib/remote-pairing-copy'
import { assertEnvironmentPairing, callEnvironmentEnvelope } from './web-runtime-calls'
import { createWebWslHostsApi } from './web-desktop-compat-api'
import { noopUnsubscribe } from './web-storage'
import { expectsBrowserClientHosting } from '../../../../shared/browser-client-hosting-eligibility'
import { isTauriNativeHost } from '../tauri-native-host'
import {
  closeTauriBrowserClientHost,
  ensureTauriBrowserClientHost
} from '../tauri-native-browser-client-host'
import {
  closeActiveRuntimeClients,
  subscribeWebRuntimeStatus,
  readWebRuntimeStatusSnapshots,
  observeWebRuntimeStatus,
  disconnectActiveRuntimeEnvironment,
  getClientForEnvironment,
  manuallyDisconnectedEnvironmentIds,
  removeActiveRuntimeEnvironment,
  requireActiveEnvironmentOrNull,
  resolveEnvironment,
  webRuntimeState,
  runtimeCallQueuePool,
  updateEnvironmentFromResponse,
  manuallyDisconnectedResponse
} from './web-runtime-session'

export function createRuntimeEnvironmentsApi(): NonNullable<
  Partial<PreloadApi>['runtimeEnvironments']
> {
  return {
    wslHosts: createWebWslHostsApi(),
    onStatusChanged: subscribeWebRuntimeStatus,
    onWslAccountNotApplied: (_callback: (event: WslOrcadAccountNotAppliedEvent) => void) =>
      noopUnsubscribe,
    onSharedControlDiagnostics: () => noopUnsubscribe,
    getStatusSnapshots: async () => readWebRuntimeStatusSnapshots(),
    list: async () => {
      const environment = requireActiveEnvironmentOrNull()
      return environment ? [redactStoredWebRuntimeEnvironment(environment)] : []
    },
    addFromPairingCode: async ({ name, pairingCode }) => {
      const offer = parseWebPairingInput(pairingCode)
      if (!offer) {
        throw new Error('Invalid Orca pairing code.')
      }
      const previousEnvironment = webRuntimeState.activeEnvironment
      closeActiveRuntimeClients()
      webRuntimeState.activeEnvironment = createStoredWebRuntimeEnvironment({
        name,
        offer,
        previousEnvironment
      })
      manuallyDisconnectedEnvironmentIds.clear()
      saveStoredWebRuntimeEnvironment(webRuntimeState.activeEnvironment)
      return { environment: redactStoredWebRuntimeEnvironment(webRuntimeState.activeEnvironment) }
    },
    verifyAndAddFromPairingCode: async ({ name, pairingCode, allowLoopback }) => {
      const parsed = parseHostAccessLink(pairingCode)
      if (!parsed.ok) {
        return {
          ok: false,
          kind: 'access-link-invalid',
          message: translateHostAccessLinkError(parsed.kind)
        }
      }
      if (parsed.value.endpointKind === 'loopback' && !allowLoopback) {
        return {
          ok: false,
          kind: 'host-unreachable',
          message: translate(
            'auto.web.webPreloadApi.loopbackPairingBlocked',
            'This access link points back to this device.'
          )
        }
      }
      let client: WebRuntimeClient | null = null
      let runtimeStatus: RuntimeStatus
      try {
        client = new WebRuntimeClient(pairedRuntimeConnectionFromOffer(parsed.value.pairing))
        const response = (await client.call('status.get', undefined, {
          timeoutMs: 15_000
        })) as RuntimeRpcResponse<RuntimeStatus>
        if (!response.ok) {
          return {
            ok: false,
            kind: 'connection-interrupted',
            message: response.error.message
          }
        }
        const statusVerification = verifyRemotePairingRuntimeStatus(response.result)
        if (!statusVerification.ok) {
          return statusVerification
        }
        runtimeStatus = statusVerification.runtimeStatus
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Invalid public key')) {
          return {
            ok: false,
            kind: 'access-link-invalid',
            message: translate(
              'auto.web.webPreloadApi.remotePairingInvalidDetails',
              'This access link contains invalid connection details.'
            )
          }
        }
        if (
          isWebRuntimeUnauthorizedError(error) ||
          (error instanceof Error && error.message.startsWith('Unauthorized.'))
        ) {
          return {
            ok: false,
            kind: 'access-link-invalid',
            message: error.message
          }
        }
        return {
          ok: false,
          kind: 'host-unreachable',
          message: translate(
            'auto.web.webPreloadApi.remotePairingUnreachable',
            'Cannot reach Orca at {{endpoint}}.',
            { endpoint: parsed.value.displayEndpoint }
          )
        }
      } finally {
        client?.close()
      }
      const usesSshTunnel = parsed.value.endpointKind === 'loopback' && allowLoopback === true
      const nextEnvironment = {
        ...createStoredWebRuntimeEnvironment({
          name,
          offer: parsed.value.pairing,
          previousEnvironment: webRuntimeState.activeEnvironment,
          ...(usesSshTunnel ? { connectionDependency: 'ssh-tunnel' as const } : {})
        }),
        ...(runtimeStatus.pairedDeviceId ? { pairedDeviceId: runtimeStatus.pairedDeviceId } : {})
      }
      // Why: a browser storage failure must leave the currently active host usable.
      try {
        saveStoredWebRuntimeEnvironment(nextEnvironment)
      } catch {
        return {
          ok: false,
          kind: 'environment-save-failed',
          message: translate(
            'auto.web.webPreloadApi.remotePairingSaveFailed',
            'Orca verified the host but could not save it. Check browser storage and try again.'
          )
        }
      }
      manuallyDisconnectedEnvironmentIds.clear()
      closeActiveRuntimeClients()
      webRuntimeState.activeEnvironment = nextEnvironment
      getClientForEnvironment(nextEnvironment).statusOwner?.acceptVerified({
        id: 'status.get',
        ok: true,
        result: runtimeStatus,
        _meta: { runtimeId: runtimeStatus.runtimeId }
      })
      return {
        ok: true,
        environment: redactStoredWebRuntimeEnvironment(nextEnvironment),
        runtimeStatus
      }
    },
    // Why: the browser keeps a single paired server; pairing it again replaces that one.
    repairFromPairingCode: async () => ({
      ok: false,
      kind: 'environment-save-failed',
      message: translate(
        'auto.web.webPreloadApi.remotePairingRepairUnavailable',
        'Re-pairing is not available in the browser. Pair this browser with the server again.'
      )
    }),
    resolve: async ({ selector }) =>
      redactStoredWebRuntimeEnvironment(resolveEnvironment(selector)),
    remove: async ({ selector }) => {
      const environment = resolveEnvironment(selector)
      if (webRuntimeState.activeEnvironment?.id === environment.id) {
        removeActiveRuntimeEnvironment()
      }
      manuallyDisconnectedEnvironmentIds.delete(environment.id)
      return { removed: redactStoredWebRuntimeEnvironment(environment) }
    },
    disconnect: async ({ selector }) => {
      const environment = resolveEnvironment(selector)
      if (webRuntimeState.activeEnvironment?.id === environment.id) {
        manuallyDisconnectedEnvironmentIds.add(environment.id)
        disconnectActiveRuntimeEnvironment()
      }
      return { disconnected: redactStoredWebRuntimeEnvironment(environment) }
    },
    connect: ({ selector, timeoutMs }) => {
      const environment = resolveEnvironment(selector)
      manuallyDisconnectedEnvironmentIds.delete(environment.id)
      closeActiveRuntimeClients()
      return callEnvironmentEnvelope<RuntimeStatus>(
        environment.id,
        'status.get',
        undefined,
        timeoutMs
      )
    },
    getStatus: ({ selector, timeoutMs, observeOnly }) =>
      observeOnly
        ? observeWebRuntimeStatus(selector, timeoutMs)
        : callEnvironmentEnvelope<RuntimeStatus>(selector, 'status.get', undefined, timeoutMs),
    retryControlConnection: () => Promise.resolve(),
    prepareBrowserClientHostPlacement: async ({
      selector,
      expectedPairingRevision,
      preference
    }) => {
      // The plain web client never hosts pages; only the Tauri desktop can.
      if (!isTauriNativeHost()) {
        return { kind: 'server' as const }
      }
      if (preference === 'server') {
        return { kind: 'server' as const }
      }
      const initialEnvironment = resolveEnvironment(selector)
      if (manuallyDisconnectedEnvironmentIds.has(initialEnvironment.id)) {
        throw new Error('runtime_manually_disconnected')
      }
      const pairingRevision = initialEnvironment.pairingRevision ?? initialEnvironment.createdAt
      if (expectedPairingRevision !== undefined && pairingRevision !== expectedPairingRevision) {
        throw new Error('browser_client_host_pairing_changed')
      }
      const response = await callEnvironmentEnvelope<RuntimeStatus>(
        selector,
        'status.get',
        undefined
      )
      if (!response.ok) {
        // An unanswered probe never told us whether this host can client-host.
        return { kind: 'server' as const }
      }
      const status = response.result
      if (status.runtimeId !== response._meta.runtimeId) {
        throw new Error('browser_client_host_runtime_identity_changed')
      }
      const environment = resolveEnvironment(initialEnvironment.id)
      const currentRevision = environment.pairingRevision ?? environment.createdAt
      if (expectedPairingRevision !== undefined && currentRevision !== expectedPairingRevision) {
        throw new Error('browser_client_host_pairing_changed')
      }
      let enabled = true
      try {
        // Lazy so the preload layer never statically depends on the store.
        const { useAppStore } = await import('@/store')
        enabled = useAppStore.getState().settings?.browserClientHostedRemoteEnabled !== false
      } catch {
        enabled = true
      }
      if (
        !expectsBrowserClientHosting({
          enabled,
          preference,
          deviceScope: status.deviceScope,
          capabilities: status.capabilities
        })
      ) {
        return { kind: 'server' as const }
      }
      if (status.graphStatus !== 'ready') {
        throw new Error('browser_client_host_runtime_not_ready')
      }
      try {
        const authority = await ensureTauriBrowserClientHost({
          environmentId: initialEnvironment.id,
          authorityRuntimeId: status.runtimeId,
          client: getClientForEnvironment(environment)
        })
        if (manuallyDisconnectedEnvironmentIds.has(initialEnvironment.id)) {
          await closeTauriBrowserClientHost(initialEnvironment.id).catch(() => false)
          throw new Error('runtime_manually_disconnected')
        }
        if (authority.authorityRuntimeId !== status.runtimeId) {
          await closeTauriBrowserClientHost(initialEnvironment.id).catch(() => false)
          throw new Error('browser_client_host_runtime_identity_changed')
        }
        return { kind: 'client' as const, browserHostClientId: authority.browserHostClientId }
      } catch (error) {
        // A host that cannot attach must not fail the tab: server pages keep working.
        console.warn(
          '[tauri-browser-client-host] client placement unavailable, using server:',
          error
        )
        return { kind: 'server' as const }
      }
    },
    call: ({
      selector,
      method,
      params,
      timeoutMs,
      expectedEnvironmentPairingRevision,
      expectedEnvironmentRuntimeId
    }) =>
      callEnvironmentEnvelope(
        selector,
        method,
        params,
        timeoutMs,
        expectedEnvironmentPairingRevision,
        expectedEnvironmentRuntimeId
      ),
    cancelSubscription: async ({ subscriptionId }) => {
      pendingSubscriptions.get(subscriptionId)?.abort()
    },
    subscribe: async (
      { selector, method, params, timeoutMs, subscriptionId, expectedEnvironmentPairingRevision },
      callbacks
    ) => {
      const environment = resolveEnvironment(selector)
      assertEnvironmentPairing(selector, expectedEnvironmentPairingRevision)
      const client = getClientForEnvironment(environment)
      const controller = new AbortController()
      if (subscriptionId) {
        if (pendingSubscriptions.has(subscriptionId)) {
          throw new Error('Subscription id already exists')
        }
        pendingSubscriptions.set(subscriptionId, controller)
      }
      let subscription
      try {
        subscription = await runtimeCallQueuePool.enqueue(
          environment.id,
          method,
          () => {
            assertEnvironmentPairing(selector, expectedEnvironmentPairingRevision)
            if (manuallyDisconnectedEnvironmentIds.has(environment.id)) {
              throw new Error('runtime_manually_disconnected')
            }
            return client.subscribe(
              method,
              params,
              {
                ...callbacks,
                onResponse: (response) => {
                  try {
                    assertEnvironmentPairing(selector, expectedEnvironmentPairingRevision)
                  } catch (error) {
                    callbacks.onError?.({
                      code: 'runtime_environment_changed',
                      message: String(error)
                    })
                    callbacks.onClose?.()
                    controller.abort()
                    return
                  }
                  const result = manuallyDisconnectedEnvironmentIds.has(environment.id)
                    ? manuallyDisconnectedResponse(environment)
                    : response
                  updateEnvironmentFromResponse(environment, result)
                  callbacks.onResponse(result)
                }
              },
              { timeoutMs, signal: controller.signal }
            )
          },
          0,
          controller.signal
        )
      } finally {
        if (subscriptionId && pendingSubscriptions.get(subscriptionId) === controller) {
          pendingSubscriptions.delete(subscriptionId)
        }
      }
      if (manuallyDisconnectedEnvironmentIds.has(environment.id)) {
        subscription.unsubscribe()
        throw new Error('runtime_manually_disconnected')
      }
      return subscription
    }
  }
}
