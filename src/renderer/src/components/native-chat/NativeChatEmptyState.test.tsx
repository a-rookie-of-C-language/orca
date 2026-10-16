// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { NativeChatEmptyState } from './NativeChatEmptyState'

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
