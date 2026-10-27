import { useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  adoptsCliConversations,
  type CliConversationRowAgent
} from '../../../../shared/structured-agent-cli-conversation-adoption'
import { useAppStore } from '@/store'
import { useAllWorktrees, useRepos } from '@/store/selectors'
import { resolveAiVaultPanelSessionListRequest } from '@/components/right-sidebar/ai-vault-panel-session-list-request'
import { useAiVaultPanelSessionResume } from '@/components/right-sidebar/use-ai-vault-panel-session-resume'
import { useAiVaultSessionRefresh } from '@/components/right-sidebar/ai-vault-session-refresh'
import { resumeAiVaultSessionInNewChat } from '@/components/right-sidebar/ai-vault-session-resume-in-chat-launch'
import type { AiVaultSessionResumeTargetState } from '@/components/right-sidebar/ai-vault-session-resume'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'

export type NativeChatSessionHistoryItem = {
  session: AiVaultSession
  rowAgent: CliConversationRowAgent
}

export type NativeChatSessionHistory = {
  items: readonly NativeChatSessionHistoryItem[]
  loading: boolean
  error: string | null
  resume: (item: NativeChatSessionHistoryItem) => void
}

const EMPTY_SCOPE_PATHS: readonly string[] = []
const MAX_VISIBLE_HISTORY_ITEMS = 8

/** Loads resumable Codex and Claude conversations for the workspace behind this chat pane. */
export function useNativeChatSessionHistory(workspaceId: string | null): NativeChatSessionHistory {
  const repos = useRepos()
  const allWorktrees = useAllWorktrees()
  const state = useAppStore(
    useShallow((current) => ({
      activeRepoId: current.activeRepoId,
      activeWorktreeId: current.activeWorktreeId,
      activeWorkspaceExecutionHostId: current.activeWorkspaceExecutionHostId,
      detectedWorktreesByRepo: current.detectedWorktreesByRepo,
      floatingWorkspacePath: current.floatingWorkspacePath,
      folderWorkspaces: current.folderWorkspaces,
      projectGroups: current.projectGroups,
      endpointProjectHostSetups: current.endpointProjectHostSetups,
      endpointProjects: current.endpointProjects,
      repos: current.repos,
      settings: current.settings,
      worktreesByRepo: current.worktreesByRepo
    }))
  )
  const targetState: AiVaultSessionResumeTargetState = useMemo(
    () => ({
      folderWorkspaces: state.folderWorkspaces,
      projectGroups: state.projectGroups,
      repos: state.repos,
      worktreesByRepo: state.worktreesByRepo,
      endpointProjects: state.endpointProjects,
      endpointProjectHostSetups: state.endpointProjectHostSetups,
      settings: state.settings
    }),
    [
      state.folderWorkspaces,
      state.projectGroups,
      state.endpointProjects,
      state.endpointProjectHostSetups,
      state.repos,
      state.settings,
      state.worktreesByRepo
    ]
  )
  const request = useMemo(
    () =>
      workspaceId
        ? resolveAiVaultPanelSessionListRequest(
            {
              ...state,
              activeRepoId: state.activeRepoId,
              activeWorktreeId: state.activeWorktreeId,
              activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId
            },
            workspaceId
          )
        : null,
    [state, workspaceId]
  )
  const history = useAiVaultSessionRefresh(
    request?.scopePaths ?? EMPTY_SCOPE_PATHS,
    request?.executionHostScope ?? 'local',
    request?.sessionLimit ?? 250,
    { enabled: workspaceId !== null }
  )
  const resume = useAiVaultPanelSessionResume({
    sessions: history.sessions,
    repos,
    allWorktrees,
    workspaceId,
    resumeTargetState: targetState,
    settings: state.settings
  })
  const items = useMemo<readonly NativeChatSessionHistoryItem[]>(() => {
    if (!workspaceId) {
      return []
    }
    return history.sessions
      .flatMap((session) => {
        if (session.agent !== 'codex' && session.agent !== 'claude') {
          return []
        }
        const rowAgent = adoptsCliConversations(session.agent) ? session.agent : null
        if (!rowAgent) {
          return []
        }
        const eligibility = resume.getSessionResumeInChat(session)
        return eligibility.available && eligibility.workspaceId === workspaceId
          ? [{ session, rowAgent }]
          : []
      })
      .sort((left, right) => right.session.modifiedAt.localeCompare(left.session.modifiedAt))
      .slice(0, MAX_VISIBLE_HISTORY_ITEMS)
  }, [history.sessions, resume, workspaceId])
  const resumeItem = useCallback(
    (item: NativeChatSessionHistoryItem): void => {
      if (!workspaceId) {
        return
      }
      void resumeAiVaultSessionInNewChat(
        item.session,
        item.rowAgent,
        workspaceId,
        newAgentLaunchRequestId()
      )
    },
    [workspaceId]
  )
  return {
    items,
    loading: history.loading,
    error: history.error,
    resume: resumeItem
  }
}
