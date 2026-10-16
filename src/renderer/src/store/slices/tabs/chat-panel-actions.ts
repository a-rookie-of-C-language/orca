import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { findTabAndWorktree } from '../tab-group-state'

export function createChatPanelActions(
  set: TabsSliceSet,
  get: TabsSliceGet
): Pick<TabsSlice, 'dockChatTab' | 'restoreChatTabBar'> {
  return {
    dockChatTab: (tabId) => {
      const found = findTabAndWorktree(get().unifiedTabsByWorktree, tabId)
      if (!found || found.tab.contentType !== 'agent-session') {
        return false
      }
      const { worktreeId, tab } = found
      const groups = get().groupsByWorktree[worktreeId] ?? []
      const source = groups.find((group) => group.id === tab.groupId)
      if (!source) {
        return false
      }
      const existingPanel = groups.find((group) => group.isChatPanel)
      if (existingPanel && existingPanel.id !== source.id) {
        return get().moveUnifiedTabToGroup(tabId, existingPanel.id, { activate: true })
      }
      const groupTabs = get().unifiedTabsByWorktree[worktreeId] ?? []
      const containsOtherContent = groupTabs.some(
        (item) => item.groupId === source.id && item.contentType !== 'agent-session'
      )
      // Reuse tab moves so a running chat keeps its retained renderer and host identity.
      if (
        containsOtherContent &&
        !get().dropUnifiedTab(tabId, { groupId: source.id, splitDirection: 'left' })
      ) {
        return false
      }
      const moved = get().getTab(tabId)
      if (!moved) {
        return false
      }
      set((state) => ({
        groupsByWorktree: {
          ...state.groupsByWorktree,
          [worktreeId]: state.groupsByWorktree[worktreeId].map((group) =>
            group.id === moved.groupId ? { ...group, isChatPanel: true } : group
          )
        }
      }))
      return true
    },
    restoreChatTabBar: (worktreeId, groupId) => {
      set((state) => ({
        groupsByWorktree: {
          ...state.groupsByWorktree,
          [worktreeId]: (state.groupsByWorktree[worktreeId] ?? []).map((group) => {
            if (group.id !== groupId || !group.isChatPanel) {
              return group
            }
            const { isChatPanel: _panel, ...restored } = group
            return restored
          })
        }
      }))
    }
  }
}
