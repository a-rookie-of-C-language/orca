import { describe, expect, it, vi } from 'vitest'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { createTestStore, seedStore } from './store-test-helpers'
import { buildPersistedUnifiedTabSessionData } from '@/lib/workspace-session-unified-tabs'
import { parseWorkspaceSession } from '../../../../shared/workspace-session-schema'
import { buildHydratedTabState } from './tabs-hydration'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
createTabsSliceMockApi()

function chatStore(worktreeId = 'folder:project') {
  const store = createTestStore()
  seedStore(store, { activeWorktreeId: worktreeId })
  const chat = store.getState().createUnifiedTab(worktreeId, 'agent-session', {
    id: 'chat-1',
    entityId: 'session-1',
    agentSessionAgent: 'claude',
    executionHostId: 'local'
  })
  return { store, chat, worktreeId }
}

describe('fixed chat panels', () => {
  it.each(['folder:project', 'repo::/project'])(
    'keeps a chat visible while files open in %s',
    (id) => {
      const { store, chat, worktreeId } = chatStore(id)
      expect(store.getState().dockChatTab(chat.id)).toBe(true)
      const first = store.getState().createUnifiedTab(worktreeId, 'editor', { id: 'file-a' })
      expect(first.groupId).not.toBe(chat.groupId)
      expect(
        store.getState().groupsByWorktree[worktreeId].find((g) => g.isChatPanel)
      ).toMatchObject({
        id: chat.groupId,
        activeTabId: chat.id,
        tabOrder: [chat.id]
      })
      store.getState().focusGroup(worktreeId, chat.groupId)
      const second = store.getState().createUnifiedTab(worktreeId, 'diff', { id: 'file-b' })
      expect(second.groupId).toBe(first.groupId)
      expect(store.getState().layoutByWorktree[worktreeId]).toMatchObject({
        type: 'split',
        direction: 'horizontal',
        first: { groupId: chat.groupId },
        second: { groupId: first.groupId }
      })
    }
  )

  it('docks an existing chat without changing its session or losing open files', () => {
    const { store, chat, worktreeId } = chatStore()
    const file = store.getState().createUnifiedTab(worktreeId, 'editor', { id: 'file-a' })
    store.getState().activateTab(chat.id)
    expect(store.getState().dockChatTab(chat.id)).toBe(true)
    const moved = store.getState().getTab(chat.id)
    expect(moved).toMatchObject({ id: chat.id, entityId: 'session-1', executionHostId: 'local' })
    expect(moved?.groupId).not.toBe(file.groupId)
    expect(
      store.getState().groupsByWorktree[worktreeId].find((g) => g.id === file.groupId)?.activeTabId
    ).toBe(file.id)
  })

  it('opens real editor items outside the panel even when the caller targets it', () => {
    const { store, chat, worktreeId } = chatStore()
    store.getState().dockChatTab(chat.id)
    store.getState().openFile(
      {
        filePath: '/project/first.ts',
        relativePath: 'first.ts',
        worktreeId,
        language: 'typescript',
        mode: 'edit'
      },
      { targetGroupId: chat.groupId }
    )
    const editor = store
      .getState()
      .unifiedTabsByWorktree[worktreeId].find((t) => t.contentType === 'editor')
    expect(editor?.groupId).not.toBe(chat.groupId)
    store.getState().focusGroup(worktreeId, chat.groupId)
    store.getState().openFile({
      filePath: '/project/second.ts',
      relativePath: 'second.ts',
      worktreeId,
      language: 'typescript',
      mode: 'edit'
    })
    expect(
      store
        .getState()
        .unifiedTabsByWorktree[worktreeId].filter((t) => t.contentType === 'editor')
        .every((t) => t.groupId === editor?.groupId)
    ).toBe(true)
    expect(
      store.getState().groupsByWorktree[worktreeId].find((g) => g.isChatPanel)?.activeTabId
    ).toBe(chat.id)
  })

  it('recreates the file area after the last file closes', () => {
    const { store, chat, worktreeId } = chatStore()
    store.getState().dockChatTab(chat.id)
    const file = store.getState().createUnifiedTab(worktreeId, 'editor', { id: 'file-a' })
    store.getState().closeUnifiedTab(file.id)
    const next = store.getState().createUnifiedTab(worktreeId, 'editor', { id: 'file-b' })
    expect(next.groupId).not.toBe(chat.groupId)
    expect(store.getState().getTab(chat.id)?.entityId).toBe('session-1')
  })

  it('switches chats within one panel and can restore the normal tab bar', () => {
    const { store, chat, worktreeId } = chatStore()
    store.getState().dockChatTab(chat.id)
    const second = store
      .getState()
      .createUnifiedTab(worktreeId, 'agent-session', { id: 'chat-2', agentSessionAgent: 'codex' })
    expect(second.groupId).toBe(chat.groupId)
    store.getState().restoreChatTabBar(worktreeId, chat.groupId)
    expect(store.getState().groupsByWorktree[worktreeId][0].isChatPanel).toBeUndefined()
    const file = store.getState().createUnifiedTab(worktreeId, 'editor', { id: 'file' })
    expect(file.groupId).toBe(chat.groupId)
  })

  it('adds new chats to the panel while the file area has focus', () => {
    const { store, chat, worktreeId } = chatStore()
    store.getState().dockChatTab(chat.id)
    const file = store.getState().createUnifiedTab(worktreeId, 'editor', { id: 'file' })
    store.getState().focusGroup(worktreeId, file.groupId)
    const next = store
      .getState()
      .createUnifiedTab(worktreeId, 'agent-session', { id: 'chat-2', agentSessionAgent: 'codex' })
    expect(next.groupId).toBe(chat.groupId)
  })

  it('preserves the execution host when docking a paired-server chat', () => {
    const { store, chat, worktreeId } = chatStore()
    store.setState((state) => ({
      unifiedTabsByWorktree: {
        [worktreeId]: state.unifiedTabsByWorktree[worktreeId].map((tab) => ({
          ...tab,
          executionHostId: 'runtime:paired-host' as const
        }))
      }
    }))
    store.getState().createUnifiedTab(worktreeId, 'editor', { id: 'file' })
    store.getState().dockChatTab(chat.id)
    expect(store.getState().getTab(chat.id)).toMatchObject({
      entityId: 'session-1',
      executionHostId: 'runtime:paired-host'
    })
  })

  it('does not let a file drag replace a fixed chat', () => {
    const { store, chat, worktreeId } = chatStore()
    store.getState().dockChatTab(chat.id)
    const file = store.getState().createUnifiedTab(worktreeId, 'editor', { id: 'file' })
    expect(store.getState().moveUnifiedTabToGroup(file.id, chat.groupId)).toBe(false)
    expect(store.getState().dropUnifiedTab(file.id, { groupId: chat.groupId })).toBe(false)
  })

  it('round-trips the fixed panel and its resized layout through session persistence', () => {
    const { store, chat, worktreeId } = chatStore()
    store.getState().dockChatTab(chat.id)
    store.getState().createUnifiedTab(worktreeId, 'editor', { id: 'file' })
    store.getState().setTabGroupSplitRatio(worktreeId, '', 0.4)
    const saved = buildPersistedUnifiedTabSessionData(store.getState())
    const parsed = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: worktreeId,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      ...saved
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      throw new Error('invalid session')
    }
    const restored = buildHydratedTabState(parsed.value, new Set([worktreeId]))
    expect(restored.groupsByWorktree[worktreeId].find((g) => g.isChatPanel)?.id).toBe(chat.groupId)
    expect(restored.layoutByWorktree[worktreeId]).toMatchObject({ ratio: 0.4 })
  })
})
