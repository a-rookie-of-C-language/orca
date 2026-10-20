// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import type { NativeChatSessionHistory } from './use-native-chat-session-history'

afterEach(cleanup)

it('keeps pointing the terminal-backed chat back to its terminal when a read fails', () => {
  render(<NativeChatEmptyState kind="error" />)
  expect(
    screen.getByText(
      'The transcript could not be read. Toggle back to the terminal to keep working.'
    )
  ).toBeInTheDocument()
})

it('shows the host message in place of the terminal-backed default', () => {
  render(<NativeChatEmptyState kind="error" message="disk full" />)
  expect(screen.getByText('disk full')).toBeInTheDocument()
  expect(screen.queryByText(/Toggle back to the terminal/)).toBeNull()
})

it.each(['claude', 'codex', 'opencode'] as const)(
  'shows the %s brand icon on the welcome screen',
  (agent) => {
    const { container } = render(<NativeChatEmptyState kind="empty" agent={agent} />)
    expect(container.querySelector(`[data-agent-icon="${agent}"] svg`)).toBeInTheDocument()
    expect(container.querySelector('.lucide-message-square')).toBeNull()
  }
)

it('updates the welcome icon with the conversation provider', () => {
  const { container, rerender } = render(<NativeChatEmptyState kind="empty" agent="claude" />)
  rerender(<NativeChatEmptyState kind="empty" agent="codex" />)
  expect(container.querySelector('[data-agent-icon="codex"] svg')).toBeInTheDocument()
  expect(container.querySelector('[data-agent-icon="claude"]')).toBeNull()
})

it('keeps the error warning instead of displaying a provider logo', () => {
  const { container } = render(<NativeChatEmptyState kind="error" agent="codex" />)
  expect(container.querySelector('.lucide-triangle-alert')).toBeInTheDocument()
  expect(container.querySelector('[data-agent-icon]')).toBeNull()
})

it('retains the neutral icon when the provider is not known', () => {
  const { container } = render(<NativeChatEmptyState kind="not-agent" />)
  expect(container.querySelector('.lucide-message-square')).toBeInTheDocument()
})

it('offers resumable provider sessions while the chat is empty', () => {
  const session: AiVaultSession = {
    id: 'codex-1',
    executionHostId: 'local',
    agent: 'codex',
    sessionId: 'codex-1',
    title: 'Fix the sidebar',
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: '/sessions/codex-1.jsonl',
    codexHome: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
    modifiedAt: '2025-01-02T00:00:00.000Z',
    messageCount: 2,
    totalTokens: 10,
    previewMessages: [
      { role: 'user', text: 'Make the sidebar persist', timestamp: '2025-01-02T00:00:00.000Z' }
    ],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'codex resume codex-1',
    subagent: null
  }
  const resume = vi.fn()
  const history: NativeChatSessionHistory = {
    items: [{ session, rowAgent: 'codex' }],
    loading: false,
    error: null,
    resume
  }

  render(<NativeChatEmptyState kind="empty" history={history} />)

  expect(screen.getByText('Recent sessions')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Fix the sidebar/ })).toBeInTheDocument()
  expect(screen.getByText('Make the sidebar persist')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /Fix the sidebar/ }))
  expect(resume).toHaveBeenCalledWith(history.items[0])
})
