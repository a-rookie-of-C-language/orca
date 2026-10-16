import { createBrowserUuid } from '@/lib/browser-uuid'
import type { TabsSlice } from './tabs-slice-contract'
import { insertSplitGroup } from './tabs-group-actions'
import { sanitizeRecentTabIds } from '../tab-group-state'
import { applyTabOrderSortValues } from '../../../../../shared/workspace-layout/tab-order'

type ChatPanelLayout = Pick<
  TabsSlice,
  'unifiedTabsByWorktree' | 'groupsByWorktree' | 'activeGroupIdByWorktree' | 'layoutByWorktree'
>

/** Separate chat chrome without changing session identities or the focused content. */
export function applyDefaultChatPanelLayout(
  state: ChatPanelLayout,
  worktreeId: string
): ChatPanelLayout {
  let next = state
  for (const group of state.groupsByWorktree[worktreeId] ?? []) {
    const tabs = next.unifiedTabsByWorktree[worktreeId] ?? []
    const chatIds = new Set(
      tabs
        .filter((tab) => tab.groupId === group.id && tab.contentType === 'agent-session')
        .map((tab) => tab.id)
    )
    if (chatIds.size === 0) {
      continue
    }
    const chatOrder = group.tabOrder.filter((id) => chatIds.has(id))
    const contentOrder = group.tabOrder.filter((id) => !chatIds.has(id))
    if (contentOrder.length === 0) {
      if (!group.isChatPanel) {
        next = {
          ...next,
          groupsByWorktree: {
            ...next.groupsByWorktree,
            [worktreeId]: next.groupsByWorktree[worktreeId].map((item) =>
              item.id === group.id ? { ...item, isChatPanel: true } : item
            )
          }
        }
      }
      continue
    }
    const chatGroupId = createBrowserUuid()
    const activeIsChat = group.activeTabId !== null && chatIds.has(group.activeTabId)
    const chatRecent = sanitizeRecentTabIds(group.recentTabIds, chatOrder)
    const contentRecent = sanitizeRecentTabIds(group.recentTabIds, contentOrder)
    const split = insertSplitGroup(
      next,
      worktreeId,
      {
        sourceGroupId: group.id,
        splitDirection: 'left',
        activate: next.activeGroupIdByWorktree[worktreeId] === group.id && activeIsChat
      },
      {
        id: chatGroupId,
        worktreeId,
        isChatPanel: true,
        activeTabId: activeIsChat ? group.activeTabId : (chatRecent.at(-1) ?? chatOrder[0]),
        tabOrder: chatOrder,
        recentTabIds: chatRecent
      }
    )
    const movedTabs = tabs.map((tab) =>
      chatIds.has(tab.id) ? { ...tab, groupId: chatGroupId } : tab
    )
    next = {
      ...split,
      unifiedTabsByWorktree: {
        ...next.unifiedTabsByWorktree,
        [worktreeId]: applyTabOrderSortValues(
          applyTabOrderSortValues(movedTabs, chatOrder),
          contentOrder
        )
      },
      groupsByWorktree: {
        ...split.groupsByWorktree,
        [worktreeId]: split.groupsByWorktree[worktreeId].map((item) =>
          item.id === group.id
            ? {
                ...item,
                isChatPanel: false,
                tabOrder: contentOrder,
                activeTabId:
                  !activeIsChat && group.activeTabId
                    ? group.activeTabId
                    : (contentRecent.at(-1) ?? contentOrder[0]),
                recentTabIds: contentRecent
              }
            : item
        )
      }
    }
  }
  return next
}
