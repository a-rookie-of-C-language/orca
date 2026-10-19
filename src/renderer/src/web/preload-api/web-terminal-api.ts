import type { PreloadApi } from '../../../../preload/api-types'
import type {
  PtyManagementApi,
  PtyManagementFolderAccessMismatch,
  PtyManagementMacTccAttributionHealth,
  PtyManagementSeveredDaemon,
  PtyManagementSeveredDaemonRestartResult,
  PtyManagementSession
} from '../../../../preload/api/pty-management-api'
import type { DaemonAsyncIoStatus } from '../../../../shared/daemon-async-io-health'
import { EMPTY_PTY_MAIN_DELIVERY_DIAGNOSTICS } from '../../../../shared/pty-delivery-diagnostics'
import { callEnvironmentEnvelope, callRuntimeResult } from './web-runtime-calls'
import { unwrapRuntimeRpcResult } from '../../runtime/runtime-rpc-result'
import { noopUnsubscribe } from './web-storage'
import { isTauriNativeHost } from '../tauri-native-host'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import type {
  TerminalLeafMoveRequest,
  TerminalLeafMoveResult
} from '../../../../shared/terminal-leaf-move'
import { requireActiveEnvironment } from './web-runtime-session'
import { confirmRuntimeTerminalForegroundProcess } from '../../runtime/runtime-terminal-inspection'
import { getRemoteRuntimePtyOwner } from '../../runtime/runtime-terminal-stream'
import { createTauriPtyDeliveryDiagnostics } from '../tauri-pty-delivery-diagnostics'
import { createTauriPtyApi } from './web-tauri-pty-api'
import { createRuntimePtyQueryApi } from './web-terminal-runtime-queries'
export { createSshApi } from './web-ssh-api'

export function createPtyApi(): NonNullable<Partial<PreloadApi>['pty']> {
  const nativePty = createTauriPtyApi()
  const deliveryDiagnostics = isTauriNativeHost() ? createTauriPtyDeliveryDiagnostics() : null
  let tauriDataListenerCount = 0
  return {
    ...nativePty,
    ...createRuntimePtyQueryApi(),
    ackColdRestore: () => {},
    // Web panes never transit main's hidden-delivery gate, so there is no drop latch.
    ackHiddenOutputRestoreApplied: () => {},
    ackData: (id, charCount, processedChars) => {
      deliveryDiagnostics?.recordAck(id, charCount, processedChars)
    },
    onDeliveryResyncRequest: () => noopUnsubscribe,
    respondDeliveryResync: () => {},
    // Why: web terminals bypass main's delivery gate; a zero-in-flight reply keeps the watchdog idle.
    reportRendererDeliveryState: (report) =>
      Promise.resolve(
        deliveryDiagnostics?.report(report) ?? {
          inFlightTotalChars: 0,
          inFlightPtyCount: 0,
          msSinceLastAck: null
        }
      ),
    getPtyDataListenerCount: () => (deliveryDiagnostics ? tauriDataListenerCount : 0),
    onData: (callback) => {
      const unsubscribe = nativePty.onData((event) => {
        deliveryDiagnostics?.recordData(event.id, event.rawLength ?? event.data.length)
        callback(event)
      })
      tauriDataListenerCount += 1
      return () => {
        unsubscribe()
        tauriDataListenerCount = Math.max(0, tauriDataListenerCount - 1)
      }
    },
    onExit: (callback) =>
      nativePty.onExit((event) => {
        deliveryDiagnostics?.remove(event.id)
        callback(event)
      }),
    rendererDispatcherReady: () => deliveryDiagnostics?.setDispatcherReady(true),
    setActiveRendererPty: (id, active) => deliveryDiagnostics?.setActive(id, active),
    setRendererPtyVisible: (id, visible) => deliveryDiagnostics?.setVisible(id, visible),
    setHiddenRendererPty: (id, hidden) => deliveryDiagnostics?.setHidden(id, hidden),
    setPtyDeliveryInterest: (id, interested) => deliveryDiagnostics?.setInterested(id, interested),
    // Why: remote-runtime PTYs are never hidden-gate markable, so there's no main-side responder to feed.
    publishTerminalViewAttributes: () => {},
    // Why fail-closed like the parked/mounted panes: SSH panes hold no remote incarnation
    // to confirm against, and ownerless ids name no server to dial; callers read null as
    // "no new evidence". The helper's preload fallback is Electron's real IPC, which this
    // object replaces on web, so unreachable ids stop here instead of recursing into it.
    confirmForegroundProcess: (id) => {
      if (parseAppSshPtyId(id) !== null || getRemoteRuntimePtyOwner(id) === null) {
        return Promise.resolve(null)
      }
      return confirmRuntimeTerminalForegroundProcess(id)
    },
    // Why: a paired client's terminals belong to the host, whose Codex settings this client does not own.
    isCodexOnSharedServer: () => Promise.resolve({ joined: false }),
    disableCodexSharedServerAutoStart: () => Promise.resolve(false),
    stopCodexSharedServer: () => Promise.resolve(false),
    openedBeforeClaudeAccounts: () => Promise.resolve(false),
    // Why: the paired host owns its daemons; this client has none to stop.
    readNewerDaemonHeldScreen: () => Promise.resolve(null),
    reopenNewerDaemonTerminals: () => Promise.resolve({ reopened: false }),
    moveLeafToNewTab: async (request: TerminalLeafMoveRequest): Promise<TerminalLeafMoveResult> => {
      // Tauri commits the host's layout before mounting the new tab.
      if (!isTauriNativeHost()) {
        return { status: 'not_held' }
      }
      const environment = requireActiveEnvironment()
      if (request.ptyId) {
        const owner = parseRemoteRuntimePtyId(request.ptyId)
        if (!owner || owner.environmentId !== environment.id) {
          return { status: 'refused', reason: 'pty_mismatch' }
        }
      }
      return unwrapRuntimeRpcResult(
        await callEnvironmentEnvelope<TerminalLeafMoveResult>(
          environment.id,
          'terminal.moveLeafToNewTab',
          request,
          undefined,
          environment.pairingRevision ?? environment.createdAt
        )
      )
    },
    // Why: remote-runtime PTYs skip local main (no side-effect source); renderer byte parsing stays authoritative.
    onSideEffect: () => noopUnsubscribe,
    getSideEffectSnapshot: () => Promise.resolve(null),
    getRendererDeliveryDebugSnapshot: () =>
      Promise.resolve(
        deliveryDiagnostics?.snapshot() ?? {
          pendingPtyCount: 0,
          pendingChars: 0,
          maxPendingCharsByPty: 0,
          rendererInFlightPtyCount: 0,
          rendererInFlightChars: 0,
          maxRendererInFlightCharsByPty: 0,
          activeRendererPtyCount: 0,
          flushScheduled: false,
          peakPendingChars: 0,
          peakMaxPendingCharsByPty: 0,
          peakRendererInFlightChars: 0,
          peakMaxRendererInFlightCharsByPty: 0,
          ackGatedFlushSkipCount: 0,
          hiddenDeliveryGatedPtyCount: 0,
          hiddenDeliveryGatedVisiblePtyCount: 0,
          hiddenDeliveryGatedActivePtyCount: 0,
          deliveryInterestPtyCount: 0,
          hiddenDeliveryDroppedChars: 0,
          hiddenDeliveryDroppedChunks: 0,
          pendingDroppedChars: 0,
          diagnostics: EMPTY_PTY_MAIN_DELIVERY_DIAGNOSTICS,
          rendererLifecycleResetCount: 0,
          lastLifecycleResetClearedChars: 0,
          rendererPtyDispatcherReady: false,
          rendererDispatcherReadyForcedCount: 0
        }
      ),
    resetRendererDeliveryDebug: () => {
      deliveryDiagnostics?.reset()
      return Promise.resolve()
    },
    onModelRestoreNeeded: () => noopUnsubscribe,
    onSerializeBufferRequest: () => noopUnsubscribe,
    onClearBufferRequest: () => noopUnsubscribe,
    onResetInputModesRequest: () => noopUnsubscribe,
    sendSerializedBuffer: () => {},
    declarePendingPaneSerializer: () => Promise.resolve(0),
    settlePaneSerializer: () => Promise.resolve(),
    clearPendingPaneSerializer: () => Promise.resolve(),
    reportRendererSerializerReady: () => Promise.resolve(),
    management: {
      asyncIoHealth: () => callRuntimeResult<DaemonAsyncIoStatus>('terminalDaemon.asyncIoHealth'),
      listSessions: () =>
        callRuntimeResult<{ sessions: PtyManagementSession[]; degraded: boolean }>(
          'terminalDaemon.listSessions'
        ),
      killAll: () =>
        callRuntimeResult<Awaited<ReturnType<PtyManagementApi['killAll']>>>(
          'terminalDaemon.killAll'
        ),
      killOne: (args) => callRuntimeResult<{ success: boolean }>('terminalDaemon.killOne', args),
      restart: () => callRuntimeResult<{ success: boolean }>('terminalDaemon.restart'),
      // Why: web clients can't inspect the host daemon's pid record; 'unknown' keeps the banner hidden.
      macTccAttribution: (): Promise<{
        health: PtyManagementMacTccAttributionHealth
        folderAccessMismatch: PtyManagementFolderAccessMismatch | null
      }> => Promise.resolve({ health: 'unknown', folderAccessMismatch: null }),
      // Why: the TCC row belongs to the host's app bundle, which a web client cannot reach.
      resetFolderAccess: () => Promise.resolve({ outcome: 'unsupported' as const }),
      // Why: the host daemon's /proc evidence is not reachable from a web client.
      severedDaemon: async (): Promise<{ severed: PtyManagementSeveredDaemon | null }> => {
        const result = await callRuntimeResult<{
          severed: PtyManagementSeveredDaemon | null
        }>('terminalDaemon.severedStatus')
        return { severed: result.severed }
      },
      restartSeveredDaemon: (expected): Promise<PtyManagementSeveredDaemonRestartResult> =>
        callRuntimeResult('terminalDaemon.restartSevered', expected)
    }
  }
}
