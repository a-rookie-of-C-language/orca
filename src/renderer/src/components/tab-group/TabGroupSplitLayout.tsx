import type { TabGroupLayoutNode } from '../../../../shared/tab-types'
import { useAppStore } from '../../store'
import { resolveWorkspaceMode } from '../../app-shell/workspace-mode'
import { TabGroupSplitNodeTree } from './TabGroupSplitNodeTree'
import { WorkspaceTabDragLayer } from './WorkspaceTabDragLayer'

/** Compose main-window chrome around the shared drag scope/tree; other hosts supply their own chrome. */
export default function TabGroupSplitLayout({
  layout,
  worktreeId,
  focusedGroupId,
  isWorktreeActive
}: {
  layout: TabGroupLayoutNode
  worktreeId: string
  focusedGroupId?: string
  isWorktreeActive: boolean
}): React.JSX.Element {
  // Why: Work mode folds non-chat panes with CSS (never unmounts), so collect the chat
  // group ids once here instead of subscribing the whole tree to group updates.
  const collapseNonChatGroups = useAppStore((s) => resolveWorkspaceMode(s.settings) === 'work')
  // Why: optional chain — partial store doubles in tests may omit worktree state.
  const groups = useAppStore((s) => s.groupsByWorktree?.[worktreeId])
  // Why: plain construction, not a memo — group counts are tiny, and direct-call
  // component doubles in tests run outside a React dispatcher.
  const chatGroupIds = new Set(
    (groups ?? []).filter((group) => group.isChatPanel).map((group) => group.id)
  )
  return (
    <WorkspaceTabDragLayer worktreeId={worktreeId} enabled={isWorktreeActive}>
      {({ isTabDragActive, hoveredTabInsertion, setDragRootNode }) => (
        /* Keep the 4px drag strip outside resize panes to align the 36px header; the wrapper owns the single sidebar seam. */
        <div
          ref={setDragRootNode}
          className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden border-l border-border"
        >
          <div className="h-[4px] shrink-0 bg-card" data-terminal-focus-release-surface="true" />
          <div className="flex flex-1 min-w-0 min-h-0 overflow-hidden">
            <TabGroupSplitNodeTree
              layout={layout}
              worktreeId={worktreeId}
              focusedGroupId={focusedGroupId}
              isWorktreeActive={isWorktreeActive}
              isTabDragActive={isTabDragActive}
              hoveredTabInsertion={hoveredTabInsertion}
              collapseNonChatGroups={collapseNonChatGroups}
              chatGroupIds={chatGroupIds}
            />
          </div>
        </div>
      )}
    </WorkspaceTabDragLayer>
  )
}
