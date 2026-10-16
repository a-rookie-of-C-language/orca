// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import { TooltipProvider } from '../ui/tooltip'
import { ChatPanelHeader, DockChatButton } from './ChatPanelHeader'

const state = vi.hoisted(() => ({
  settings: { tabAutoGenerateTitle: false },
  dockChatTab: vi.fn(),
  restoreChatTabBar: vi.fn()
}))
vi.mock('../../store', () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state)
}))

const chat: Tab = {
  id: 'chat-1',
  entityId: 'session-1',
  groupId: 'chat-group',
  worktreeId: 'workspace',
  contentType: 'agent-session',
  agentSessionAgent: 'claude',
  label: 'Fix build errors',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('fixed chat panel header', () => {
  it('offers an accessible dock action without bubbling stale group focus', () => {
    const outerClick = vi.fn()
    render(
      <TooltipProvider>
        <div onClick={outerClick}>
          <DockChatButton tabId={chat.id} />
        </div>
      </TooltipProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Dock chat panel' }))
    expect(state.dockChatTab).toHaveBeenCalledWith(chat.id)
    expect(outerClick).not.toHaveBeenCalled()
  })

  it('shows the conversation title instead of a tab, with restore and close actions', () => {
    const close = vi.fn()
    render(
      <TooltipProvider>
        <ChatPanelHeader
          worktreeId="workspace"
          groupId="chat-group"
          chats={[chat]}
          activeTabId={chat.id}
          onActivate={vi.fn()}
          onClose={close}
        />
      </TooltipProvider>
    )
    expect(screen.getByText('Fix build errors')).toBeTruthy()
    expect(screen.queryByRole('tab')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Restore chat tab bar' }))
    expect(state.restoreChatTabBar).toHaveBeenCalledWith('workspace', 'chat-group')
    fireEvent.click(screen.getByRole('button', { name: 'Close chat' }))
    expect(close).toHaveBeenCalledWith(chat.id)
  })

  it('lets the reader switch conversations without a chat tab strip', async () => {
    const activate = vi.fn()
    render(
      <TooltipProvider>
        <ChatPanelHeader
          worktreeId="workspace"
          groupId="chat-group"
          chats={[chat, { ...chat, id: 'chat-2', label: 'Review changes' }]}
          activeTabId={chat.id}
          onActivate={activate}
          onClose={vi.fn()}
        />
      </TooltipProvider>
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('combobox', { name: 'Chat' }))
    })
    fireEvent.click(await screen.findByRole('option', { name: 'Review changes' }))
    expect(activate).toHaveBeenCalledWith('chat-2')
  })
})
