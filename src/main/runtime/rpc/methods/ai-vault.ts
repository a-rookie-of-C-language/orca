import { prepareStructuredChatCliFork } from '../../../ai-vault/structured-chat-cli-fork'
import {
  AiVaultSearchRequestSchema,
  AiVaultSearchStatusRequestSchema,
  AiVaultSetSearchEnabledParamsSchema
} from '../../../../shared/ai-vault-search-contract'
import {
  searchSessionService,
  sessionSearchServiceStatus
} from '../../../ai-vault-search/session-search-service-registry'
import { defineMethod } from '../core'
import { conditionalAiVaultListResult } from '../../../ai-vault/session-list-fingerprint'
import { restampAiVaultListResult } from '../../../ai-vault/session-list-results'
import { copyStructuredChatConversation } from '../../../ai-vault/structured-chat-conversation-copy'
import type { AiVaultPrepareSessionResumeArgs } from '../../../../shared/ai-vault-resume-preparation'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import { describeAiVaultScanError } from '../../../../shared/ai-vault-scan-error-message'
import {
  assertLegacyAiVaultResumeAllowed,
  projectStructuredAiVaultSessions,
  searchWithStructuredOwners
} from '../../../ai-vault/structured-session-ownership'
import {
  ensureStructuredAgentSessionHostUnlessRefused,
  tryEnsureStructuredAgentSessionHostForResume
} from '../../structured-agent-session-host-refusal'
import {
  clientOpensStructuredChatFromHistory,
  supportsStructuredAgentSessions
} from './structured-agent-session-policy'
import {
  AiVaultDeleteSessionParams,
  AiVaultListSessionsParams,
  AiVaultFirstUserPromptParams,
  AiVaultPrepareSessionDeleteParams,
  AiVaultPrepareSessionResumeParams,
  AiVaultScanProgressParams,
  AiVaultSessionTitlesParams,
  AiVaultSubagentListParams
} from '../../../../shared/rpc-contract/ai-vault-params'
export {
  AiVaultDeleteSessionParams,
  AiVaultFirstUserPromptParams,
  AiVaultListSessionsParams,
  AiVaultPrepareSessionDeleteParams,
  AiVaultPrepareSessionResumeParams,
  AiVaultScanProgressParams,
  AiVaultSessionTitlesParams,
  AiVaultSubagentListParams
}

export const AI_VAULT_METHODS = [
  defineMethod({
    name: 'aiVault.searchSessions',
    permission: 'workspace',
    params: AiVaultSearchRequestSchema,
    handler: (params, context) => {
      const response = searchSessionService(params, context.clientKind ? 'relay' : 'runtime')
      // A client that reads no structured sessions keeps the transcript hit, as before.
      return supportsStructuredAgentSessions(context)
        ? searchWithStructuredOwners(response, {
            ensureHost: () => context.runtime.ensureStructuredAgentSessionHost(),
            opensChat: (agent) => clientOpensStructuredChatFromHistory(context, agent)
          })
        : response
    }
  }),
  defineMethod({
    name: 'aiVault.searchStatus',
    permission: 'workspace',
    params: AiVaultSearchStatusRequestSchema,
    handler: (params, { clientKind }) =>
      sessionSearchServiceStatus(params, clientKind ? 'relay' : 'runtime')
  }),
  defineMethod({
    name: 'aiVault.setSearchEnabled',
    permission: 'settings-write',
    params: AiVaultSetSearchEnabledParamsSchema,
    handler: async (params, { runtime, clientKind, pairedDeviceId }) => {
      // Paired clients only: an in-process caller writes this host's own settings directly,
      // and admitting one here would let any unauthenticated local path flip consent.
      if (!pairedDeviceId) {
        throw Object.assign(
          new Error('Session search consent can only be changed by a paired client.'),
          { code: 'forbidden' }
        )
      }
      await runtime.setSessionSearchEnabled(params.enabled)
      console.warn(
        `[ai-vault-search] device ${pairedDeviceId} set indexing enabled=${params.enabled}`
      )
      return sessionSearchServiceStatus({}, clientKind ? 'relay' : 'runtime')
    }
  }),
  defineMethod({
    name: 'aiVault.clearSearchIndex',
    permission: 'settings-write',
    params: null,
    handler: async (_params, { runtime, pairedDeviceId }) => {
      if (!pairedDeviceId) {
        throw Object.assign(
          new Error('Session search index can only be cleared by a paired client.'),
          { code: 'forbidden' }
        )
      }
      await runtime.clearAiVaultSearchIndex()
    }
  }),
  defineMethod({
    name: 'aiVault.getScanProgress',
    permission: 'workspace',
    params: AiVaultScanProgressParams,
    handler: (params, { runtime }) => runtime.getAiVaultScanProgress(params.scanKey)
  }),
  defineMethod({
    name: 'aiVault.resolveSessionTitles',
    permission: 'workspace',
    params: AiVaultSessionTitlesParams,
    handler: (params, { runtime, signal }) =>
      runtime.resolveAiVaultSessionTitles(params.requests, signal)
  }),
  defineMethod({
    name: 'aiVault.listSubagentSessions',
    permission: 'workspace',
    params: AiVaultSubagentListParams,
    handler: (params, { runtime, signal }) => runtime.listAiVaultSubagentSessions(params, signal)
  }),
  defineMethod({
    name: 'aiVault.getFirstUserPrompt',
    permission: 'workspace',
    params: AiVaultFirstUserPromptParams,
    handler: (params, { runtime, signal }) => runtime.getAiVaultFirstUserPrompt(params, signal)
  }),
  defineMethod({
    name: 'aiVault.listSessions',
    permission: 'workspace',
    params: AiVaultListSessionsParams,
    handler: async (params, { runtime, clientKind, clientCapabilities, signal }) => {
      await ensureStructuredAgentSessionHostUnlessRefused(() =>
        runtime.ensureStructuredAgentSessionHost()
      )
      let result
      try {
        result = await runtime.listAiVaultSessions(
          {
            limit: params.unlimited ? undefined : params.limit,
            unlimited: params.unlimited,
            force: params.force,
            scopePaths: params.scopePaths,
            includeAntigravityIdeSessions: params.includeAntigravityIdeSessions
          },
          signal
        )
      } catch (error) {
        if (error instanceof Error) {
          error.message = describeAiVaultScanError(error.message)
          throw error
        }
        throw new Error(describeAiVaultScanError(String(error)))
      }
      // Why: web clients consume this response directly (no parent-side retag),
      // so sessions must come back stamped as the runtime host they addressed.
      const projected = projectStructuredAiVaultSessions(result, (agent) =>
        clientOpensStructuredChatFromHistory({ clientKind, clientCapabilities }, agent)
      )
      return conditionalAiVaultListResult(
        params.executionHostId
          ? restampAiVaultListResult(projected, params.executionHostId)
          : projected,
        params.unlimited ? undefined : params.afterFingerprint,
        params.force
      )
    }
  }),
  defineMethod({
    name: 'aiVault.prepareSessionResume',
    permission: 'workspace',
    params: AiVaultPrepareSessionResumeParams,
    handler: async (params, { runtime }) => {
      if ('sourceChat' in params) {
        await runtime.ensureStructuredAgentSessionHost()
        return prepareStructuredChatCliFork(params, (args) =>
          runtime.prepareAiVaultSessionResume(args)
        )
      }
      const args: AiVaultPrepareSessionResumeArgs = {
        agent: params.agent,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(params.fork ? { fork: true } : {}),
        filePath: params.filePath,
        codexHome: params.codexHome,
        // Why: the RPC executes on the transcript-owning host; never let a
        // client-provided runtime/SSH stamp escape that host boundary.
        executionHostId: LOCAL_EXECUTION_HOST_ID
      }
      if (!isWslUncPath(args.filePath)) {
        const ensureHost = () => runtime.ensureStructuredAgentSessionHost()
        await (args.codexHome === null && !args.fork
          ? tryEnsureStructuredAgentSessionHostForResume(ensureHost)
          : ensureStructuredAgentSessionHostUnlessRefused(ensureHost))
        assertLegacyAiVaultResumeAllowed(args)
      }
      return (
        (await copyStructuredChatConversation(args)) ?? runtime.prepareAiVaultSessionResume(args)
      )
    }
  }),
  defineMethod({
    name: 'aiVault.prepareSessionDelete',
    permission: 'workspace',
    params: AiVaultPrepareSessionDeleteParams,
    handler: (params, { runtime }) => runtime.prepareAiVaultSessionDelete(params)
  }),
  defineMethod({
    name: 'aiVault.deleteSession',
    permission: 'workspace',
    params: AiVaultDeleteSessionParams,
    handler: (params, { runtime }) => runtime.deleteAiVaultSession(params)
  })
]
