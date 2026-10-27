import {
  createSessionSearchClient,
  unavailableSessionSearchStatus
} from '../../../../shared/ai-vault-search-client'
import type { PreloadApi } from '../../../../preload/api-types'
import type {
  AiVaultPrepareSessionResumeRequest,
  AiVaultPrepareSessionResumeResult
} from '../../../../shared/ai-vault-resume-preparation'
import type {
  AiVaultDeleteSessionArgs,
  AiVaultDeleteSessionResult,
  AiVaultSessionDeleteValidationResult
} from '../../../../shared/ai-vault-session-deletion'
import type {
  AiVaultSessionTitlesArgs,
  AiVaultSessionTitlesResult
} from '../../../../shared/ai-vault-session-title'
import type { AiVaultSearchStatus } from '../../../../shared/ai-vault-search-types'
import type { AiVaultListArgs, AiVaultListResult } from '../../../../shared/ai-vault-types'
import {
  normalizeExecutionHostId,
  normalizeExecutionHostScope,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import type { ExecutionHostId, ExecutionHostScope } from '../../../../shared/execution-host'
import {
  assertEnvironmentPairing,
  callRuntimeEnvelope,
  callRuntimeResult,
  callEnvironmentEnvelope
} from './web-runtime-calls'
import {
  readRuntimeAiVaultDeleteSessionResponse,
  runtimeAiVaultDeleteSessionParams
} from '../../../../shared/ai-vault-runtime-session-delete'
import { requireActiveEnvironment } from './web-runtime-session'
import { noopUnsubscribe } from './web-storage'
import { translate } from '@/i18n/i18n'
import { onAiVaultScanProgress } from './web-ai-vault-runtime-events'
import { invokeNative, isTauriNativeHost } from '../tauri-native-host'
import { isWslUncPath } from '../../../../shared/wsl-paths'

export function createWebAiVaultApi(): NonNullable<Partial<PreloadApi>['aiVault']> {
  return {
    // A browser searches only its selected paired runtime.
    searchSessions: (request, executionHostScope, isActive = () => true) => {
      if (!addressesOwnRuntime(executionHostScope)) {
        return Promise.resolve({ kind: 'unavailable', reason: 'no-service' })
      }
      const environment = requireActiveEnvironment()
      const pairingRevision = environment.pairingRevision ?? environment.createdAt
      const runtimeId = environment.runtimeId ?? undefined
      const active = () => isActive() && requireActiveEnvironment().id === environment.id
      const search = createSessionSearchClient(async (method, params) => {
        if (!active()) {
          throw new Error('Session search retired')
        }
        const response = await callEnvironmentEnvelope(
          environment.id,
          method,
          params,
          undefined,
          pairingRevision,
          runtimeId,
          active
        )
        if (!response.ok) {
          throw Object.assign(new Error(response.error.message), { code: response.error.code })
        }
        return response.result
      }, 'relay')
      return search.searchSessions(request, active)
    },
    searchStatus: (executionHostScope) =>
      addressesOwnRuntime(executionHostScope)
        ? createSessionSearchClient(
            (method, params) => callRuntimeResult(method, params),
            'relay'
          ).searchStatus()
        : Promise.resolve(unavailableSessionSearchStatus()),
    // Runtime-backed web clients can change consent only for their active paired host.
    setSearchEnabled: (executionHostId, enabled): Promise<AiVaultSearchStatus> => {
      const environment = requireActiveEnvironment()
      const ownRuntimeId = toRuntimeExecutionHostId(environment.id)
      if (normalizeExecutionHostId(executionHostId) !== ownRuntimeId) {
        return Promise.reject(new Error('Agent Session History is not available for this host.'))
      }
      return callRuntimeResult<AiVaultSearchStatus>('aiVault.setSearchEnabled', { enabled })
    },
    clearSearchIndex: () => {
      requireActiveEnvironment()
      return callRuntimeResult<void>('aiVault.clearSearchIndex')
    },
    listSessions: (args?: AiVaultListArgs) => {
      const environment = requireActiveEnvironment()
      const executionHostId = toRuntimeExecutionHostId(environment.id)
      const requestedScope = normalizeExecutionHostScope(
        args?.executionHostScope ?? executionHostId
      )
      if (requestedScope !== 'all' && requestedScope !== executionHostId) {
        return Promise.resolve(webAiVaultUnavailableResult(requestedScope))
      }
      const hostPairingRevision = environment.pairingRevision ?? environment.createdAt
      // Why: no local filesystem in the browser, so every history scan runs on and is stamped as the paired runtime host.
      return callRuntimeResult<AiVaultListResult>('aiVault.listSessions', {
        includeAntigravityIdeSessions: args?.includeAntigravityIdeSessions,
        limit: args?.limit,
        force: args?.force,
        ...(requestedScope === executionHostId && args?.afterFingerprint !== undefined
          ? { afterFingerprint: args.afterFingerprint }
          : {}),
        historyOwnership: args?.historyOwnership,
        scopePaths: args?.scopePaths,
        executionHostId
      }).then((result) =>
        // Fence later host mutations on these rows to the pairing that listed them.
        result.sessions
          ? {
              ...result,
              sessions: result.sessions.map((session) => ({ ...session, hostPairingRevision }))
            }
          : result
      )
    },
    resolveSessionTitles: (args: AiVaultSessionTitlesArgs) => {
      const environment = requireActiveEnvironment()
      const executionHostId = toRuntimeExecutionHostId(environment.id)
      if (
        args.executionHostScope &&
        normalizeExecutionHostScope(args.executionHostScope) !== executionHostId
      ) {
        return Promise.resolve({ titles: [] })
      }
      return callRuntimeResult<AiVaultSessionTitlesResult>('aiVault.resolveSessionTitles', {
        requests: args.requests
      }).catch(() => ({ titles: [] }))
    },
    // No RPC cancel verb; refreshId drops late results, but the unused scan runs until its timeout.
    cancelListSessions: () => Promise.resolve(),
    prepareSessionResume: (args: AiVaultPrepareSessionResumeRequest) =>
      callRuntimeResult<AiVaultPrepareSessionResumeResult>('aiVault.prepareSessionResume', args),
    listSubagentSessions: (args) => {
      const environment = requireActiveEnvironment()
      const executionHostId = toRuntimeExecutionHostId(environment.id)
      if (normalizeExecutionHostId(args.executionHostId ?? executionHostId) !== executionHostId) {
        return Promise.resolve({ sessions: [], issues: [] })
      }
      return callRuntimeResult('aiVault.listSubagentSessions', {
        ...args,
        executionHostId
      })
    },
    getFirstUserPrompt: (args) => {
      const environment = requireActiveEnvironment()
      const executionHostId = toRuntimeExecutionHostId(environment.id)
      if (normalizeExecutionHostId(args.executionHostId ?? executionHostId) !== executionHostId) {
        return Promise.resolve({ prompt: null })
      }
      return callRuntimeResult('aiVault.getFirstUserPrompt', {
        ...args,
        executionHostId
      })
    },
    // Why: transcript decoding is local-FS only; web/runtime keeps the raw-path handoff.
    buildHandoffPack: () => Promise.resolve({ text: null }),
    deleteSession: async (args: AiVaultDeleteSessionArgs): Promise<AiVaultDeleteSessionResult> => {
      if (!isTauriNativeHost()) {
        // A browser can delete only on its own paired runtime, which validates the path itself.
        if (!addressesOwnRuntime(args.executionHostId)) {
          return { outcome: 'rejected', agent: args.agent, reason: 'non-local-host' }
        }
        assertEnvironmentPairing(
          requireActiveEnvironment().id,
          args.expectedEnvironmentPairingRevision
        )
        return readRuntimeAiVaultDeleteSessionResponse(
          await callRuntimeEnvelope(
            'aiVault.deleteSession',
            runtimeAiVaultDeleteSessionParams(args)
          ),
          args.agent
        )
      }
      const environment = requireActiveEnvironment()
      const runtimeArgs = {
        ...args,
        executionHostId: toRuntimeExecutionHostId(environment.id)
      }
      const validation = await callRuntimeResult<AiVaultSessionDeleteValidationResult>(
        'aiVault.prepareSessionDelete',
        runtimeArgs
      )
      if (!validation.allowed) {
        return { outcome: 'rejected', agent: validation.agent, reason: validation.reason }
      }

      if (validation.removals.some((removal) => isWslUncPath(removal.path))) {
        return callRuntimeResult<AiVaultDeleteSessionResult>('aiVault.deleteSession', runtimeArgs)
      }

      try {
        await invokeNative('poc_trash_ai_vault_session', { plan: validation })
      } catch (error) {
        return {
          outcome: 'failed',
          agent: validation.agent,
          error: error instanceof Error ? error.message : String(error)
        }
      }
      // Native trashing owns the filesystem mutation. The runtime call only
      // invalidates its scan/parse caches (and remains idempotent if the path
      // disappeared between the two calls).
      return callRuntimeResult<AiVaultDeleteSessionResult>('aiVault.deleteSession', runtimeArgs)
    },
    onWindowFocused: () => noopUnsubscribe,
    getScanProgress: (scanKey) => {
      requireActiveEnvironment()
      return callRuntimeResult('aiVault.getScanProgress', { scanKey })
    },
    onScanProgress: (callback) => onAiVaultScanProgress(callback)
  }
}

// Malformed scopes must not become everything; all is a desktop merge and cannot address this browser’s runtime.
function addressesOwnRuntime(executionHostScope: ExecutionHostScope | undefined): boolean {
  const ownRuntimeId = toRuntimeExecutionHostId(requireActiveEnvironment().id)
  return (
    executionHostScope === undefined ||
    normalizeExecutionHostId(executionHostScope) === ownRuntimeId
  )
}

export function webAiVaultUnavailableResult(executionHostId: ExecutionHostId): AiVaultListResult {
  return {
    sessions: [],
    issues: [
      {
        executionHostId,
        agent: 'codex',
        path: executionHostId,
        message: translate(
          'auto.web.webPreloadApi.aiVaultUnavailableForHost',
          'Agent Session History is not available for this execution host.'
        )
      }
    ],
    scannedAt: new Date().toISOString()
  }
}
