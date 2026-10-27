import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'
import type {
  AiVaultDeleteSessionArgs,
  AiVaultDeleteSessionResult,
  AiVaultSessionDeleteValidationResult
} from '../../shared/ai-vault-session-deletion'
import type {
  AiVaultSessionTitleRequest,
  AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import type {
  AiVaultFirstUserPromptArgs,
  AiVaultFirstUserPromptResult,
  AiVaultListArgs,
  AiVaultListResult,
  AiVaultSubagentListArgs,
  AiVaultSubagentListResult
} from '../../shared/ai-vault-types'
import {
  localAiVaultScanProgress,
  onLocalAiVaultScanProgress
} from '../ai-vault/ai-vault-local-scan-progress'
import {
  invalidateAiVaultBackgroundCache,
  listAiVaultSubagentSessionsInBackground,
  readAiVaultFirstUserPromptInBackground
} from '../ai-vault/session-scanner-background'
import { clearSessionSearchInService } from '../ai-vault/session-scanner-service-spawn'
import {
  getAiVaultWslHomeDirs,
  invalidateAiVaultSessionListCache,
  listAiVaultSessions
} from '../ai-vault/cached-session-list'
import { deleteAiVaultSessionForRemoteClient } from '../ai-vault/host-session-delete'
import { resolveLocalAiVaultSessionTitles } from '../ai-vault/session-title-resolver'
import { validateAiVaultSessionDeleteTarget } from '../ai-vault/session-delete-target'
import { invalidateSessionParseCacheEntry } from '../ai-vault/session-scanner-parse-cache'
import { tryDeleteWslUncPath, WslDeleteValidationError } from '../wsl-unc-delete'
import { isWslUncPath } from '../../shared/wsl-paths'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'

export class RuntimeAiVaultCommands {
  private readonly stopScanProgressBroadcast: () => void

  constructor(
    private readonly getPrepareResume: () =>
      | ((args: AiVaultPrepareSessionResumeArgs) => Promise<AiVaultPrepareSessionResumeResult>)
      | null,
    emitClientEvent?: (event: RuntimeClientEvent) => void
  ) {
    this.stopScanProgressBroadcast = onLocalAiVaultScanProgress((update) => {
      emitClientEvent?.({ type: 'aiVaultScanProgress', ...update })
    })
  }

  dispose(): void {
    this.stopScanProgressBroadcast()
  }

  list(args?: AiVaultListArgs, signal?: AbortSignal): Promise<AiVaultListResult> {
    return listAiVaultSessions(args, { signal })
  }

  resolveTitles(
    requests: AiVaultSessionTitleRequest[],
    signal?: AbortSignal
  ): Promise<AiVaultSessionTitlesResult> {
    return resolveLocalAiVaultSessionTitles(requests, signal)
  }

  listSubagentSessions(
    args: AiVaultSubagentListArgs,
    signal?: AbortSignal
  ): Promise<AiVaultSubagentListResult> {
    if (args.agent !== 'claude' && args.agent !== 'omp') {
      return Promise.resolve({ sessions: [], issues: [] })
    }
    return listAiVaultSubagentSessionsInBackground(
      { agent: args.agent, parentFilePath: args.parentFilePath },
      signal
    ).then((result) => ({
      ...result,
      sessions: result.sessions.map((session) =>
        args.executionHostId ? { ...session, executionHostId: args.executionHostId } : session
      )
    }))
  }

  getFirstUserPrompt(
    args: AiVaultFirstUserPromptArgs,
    signal?: AbortSignal
  ): Promise<AiVaultFirstUserPromptResult> {
    // The runtime RPC is already routed to the transcript-owning host. Do not
    // pass its renderer routing stamp through the local-only reader.
    return readAiVaultFirstUserPromptInBackground({ ...args, executionHostId: undefined }, signal)
  }

  clearSearchIndex(): Promise<void> {
    return clearSessionSearchInService()
  }

  getScanProgress(scanKey: string) {
    return Promise.resolve(localAiVaultScanProgress(scanKey))
  }

  delete(
    args: Omit<AiVaultDeleteSessionArgs, 'executionHostId'>
  ): Promise<AiVaultDeleteSessionResult> {
    return deleteAiVaultSessionForRemoteClient(args)
  }

  prepare(args: AiVaultPrepareSessionResumeArgs): Promise<AiVaultPrepareSessionResumeResult> {
    return this.getPrepareResume()?.(args) ?? Promise.resolve({ useRealCodexHome: false })
  }

  async prepareDelete(
    args: AiVaultDeleteSessionArgs
  ): Promise<AiVaultSessionDeleteValidationResult> {
    const wslHomeDirs = await getAiVaultWslHomeDirs()
    return validateAiVaultSessionDeleteTarget({
      agent: args.agent,
      filePath: args.filePath,
      // The RPC runs on the transcript-owning runtime. Never let a renderer's
      // routing stamp turn a local runtime operation into a remote one.
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      wslHomeDirs
    })
  }

  async deleteSession(args: AiVaultDeleteSessionArgs): Promise<AiVaultDeleteSessionResult> {
    const validation = await this.prepareDelete(args)
    if (!validation.allowed) {
      return { outcome: 'rejected', agent: validation.agent, reason: validation.reason }
    }

    const hasWslRemoval = validation.removals.some((removal) => isWslUncPath(removal.path))
    if (hasWslRemoval) {
      // A session plan is host-local. Mixed local/WSL plans indicate a tampered
      // request and must not partially remove anything.
      if (validation.removals.some((removal) => !isWslUncPath(removal.path))) {
        return { outcome: 'rejected', agent: validation.agent, reason: 'invalid-path' }
      }
      try {
        for (const removal of validation.removals) {
          await tryDeleteWslUncPath(removal.path, {
            recursive: removal.kind === 'directory',
            approvedRoots: removal.roots
          })
        }
      } catch (error) {
        if (error instanceof WslDeleteValidationError) {
          return { outcome: 'rejected', agent: validation.agent, reason: error.reason }
        }
        return {
          outcome: 'failed',
          agent: validation.agent,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }

    invalidateAiVaultSessionListCache()
    invalidateSessionParseCacheEntry(args.filePath)
    await invalidateAiVaultBackgroundCache([args.filePath]).catch((error) => {
      console.warn('[ai-vault] background cache invalidation failed:', error)
    })
    return { outcome: 'deleted' }
  }
}
