// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

type QuickLaunchItemsProps = {
  worktreeId: string
  groupId?: string
  launchSource?: string
  onFocusTerminal: (tabId: string) => void
  onTabOpened?: (tabId: string) => void
}

const mocks = vi.hoisted((): { itemsProps: QuickLaunchItemsProps | null } => ({ itemsProps: null }))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  )
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/tab-bar/QuickLaunchButton', () => ({
  QuickLaunchAgentMenuItems: (props: QuickLaunchItemsProps) => {
    mocks.itemsProps = props
    return <div data-testid="agent-items" />
  }
}))

vi.mock('@/lib/agent-status', () => ({
  agentTypeToIconAgent: () => 'codex',
  formatAgentTypeLabel: () => 'Codex'
}))

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => <span data-testid="agent-icon" />
}))

vi.mock('./use-native-chat-tab-owner', () => ({
  useNativeChatTabOwnerWorktreeId: () => 'worktree-1'
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const focusMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: focusMock
}))

const activateLaunchTabMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/activate-native-chat-agent-launch-tab', () => ({
  activateNativeChatAgentLaunchTab: activateLaunchTabMock
}))

import { NativeChatAgentLaunchMenu } from './NativeChatAgentLaunchMenu'

afterEach(() => {
  cleanup()
  mocks.itemsProps = null
})

describe('NativeChatAgentLaunchMenu', () => {
  it('opens another agent in the chat workspace and keeps the current conversation', () => {
    render(<NativeChatAgentLaunchMenu terminalTabId="tab-1" agent="codex" />)

    expect(screen.getByRole('button', { name: 'Start another agent' }).textContent).toContain(
      'Codex'
    )
    expect(mocks.itemsProps).toMatchObject({
      worktreeId: 'worktree-1',
      launchSource: 'native_chat'
    })
    expect(mocks.itemsProps?.onFocusTerminal).toBe(focusMock)
    expect(mocks.itemsProps?.onTabOpened).toBe(activateLaunchTabMock)
  })
})
