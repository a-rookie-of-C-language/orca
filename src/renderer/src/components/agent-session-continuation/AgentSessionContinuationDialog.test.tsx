// @vitest-environment happy-dom

import React, { type ReactNode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'

const mocks = vi.hoisted(() => ({
  detectAgents: vi.fn(),
  launchContinuation: vi.fn(),
  settings: { defaultTuiAgent: 'codex', disabledTuiAgents: [] }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({ settings: mocks.settings })
}))
vi.mock('@/lib/launch-agent-session-continuation', () => ({
  detectAgentSessionContinuationAgents: mocks.detectAgents,
  launchAgentSessionContinuation: mocks.launchContinuation
}))
vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => [
    { id: 'codex', label: 'Codex' },
    { id: 'pi', label: 'Pi' }
  ],
  getAgentLabel: () => 'Codex'
}))
vi.mock('@/components/agent/AgentCombobox', () => ({
  default: ({
    value,
    allowBlankTerminal
  }: {
    value: string | null
    allowBlankTerminal?: boolean
  }) =>
    React.createElement('div', {
      'data-agent': value ?? '',
      'data-allow-blank': String(allowBlankTerminal === true)
    })
}))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? React.createElement('div', null, children) : null,
  DialogContent: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  DialogDescription: ({ children }: { children?: ReactNode }) =>
    React.createElement('p', null, children),
  DialogFooter: ({ children }: { children?: ReactNode }) =>
    React.createElement('footer', null, children),
  DialogHeader: ({ children }: { children?: ReactNode }) =>
    React.createElement('header', null, children),
  DialogTitle: ({ children }: { children?: ReactNode }) => React.createElement('h2', null, children)
}))
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children?: ReactNode }) => React.createElement('div', null, children),
  SelectContent: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  SelectItem: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  SelectTrigger: ({ children }: { children?: ReactNode }) =>
    React.createElement('button', null, children),
  SelectValue: () => React.createElement('span')
}))

import { AgentSessionContinuationDialog } from './AgentSessionContinuationDialog'

function request(worktreeId: string): AgentSessionContinuationRequest {
  return {
    source: { capturedText: 'previous session', sourceAgent: 'codex' },
    worktreeId,
    workspacePath: '/repo',
    launchSource: 'sidebar'
  }
}

function codexFileRequest(worktreeId: string): AgentSessionContinuationRequest {
  return {
    source: {
      capturedText: '',
      sourceAgent: 'codex',
      sourceTitle: 'Wire the widget',
      transcriptPath: '/tmp/codex-session.jsonl',
      lastPrompt: 'wire the widget'
    },
    worktreeId,
    workspacePath: '/repo',
    initialCwd: '/repo',
    launchSource: 'sidebar'
  }
}

function startButton(container: HTMLDivElement): HTMLButtonElement {
  const buttons = [...container.querySelectorAll('button')]
  const start = buttons.find((button) => button.textContent?.includes('Start New Session'))
  if (!start) {
    throw new Error('start button not rendered')
  }
  return start
}

describe('AgentSessionContinuationDialog', () => {
  let container: HTMLDivElement
  let root: Root
  let originalApi: typeof window.api

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    originalApi = window.api
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    window.api = originalApi
  })

  it('clears a prior detection failure while detecting a new request', async () => {
    let resolveSecond: (agents: ['codex']) => void = () => {}
    mocks.detectAgents.mockRejectedValueOnce(new Error('offline')).mockReturnValueOnce(
      new Promise<['codex']>((resolve) => {
        resolveSecond = resolve
      })
    )

    await act(async () => {
      root.render(
        <AgentSessionContinuationDialog open request={request('wt-1')} onOpenChange={vi.fn()} />
      )
    })
    await vi.waitFor(() => expect(container.textContent).toContain('Could not detect Agents'))

    act(() => {
      root.render(
        <AgentSessionContinuationDialog open request={request('wt-2')} onOpenChange={vi.fn()} />
      )
    })
    expect(container.textContent).toContain('Detecting Agents')
    expect(container.textContent).not.toContain('Could not detect Agents')

    await act(async () => resolveSecond(['codex']))
    await vi.waitFor(() => expect(container.querySelector('[data-agent="codex"]')).not.toBeNull())
    // Why: continuing a chat needs an agent to resume it into.
    expect(container.querySelector('[data-allow-blank="false"]')).not.toBeNull()
  })

  it('embeds decoded transcript text when handing off across providers', async () => {
    const buildHandoffPack = vi.fn().mockResolvedValue({ text: '**user**: wire the widget' })
    window.api = { aiVault: { buildHandoffPack } } as never
    mocks.detectAgents.mockResolvedValue(['pi'])
    mocks.launchContinuation.mockResolvedValue(true)

    await act(async () => {
      root.render(
        <AgentSessionContinuationDialog
          open
          request={codexFileRequest('wt-1')}
          onOpenChange={vi.fn()}
        />
      )
    })
    await vi.waitFor(() => expect(container.querySelector('[data-agent="pi"]')).not.toBeNull())

    await act(async () => {
      startButton(container).click()
    })
    await vi.waitFor(() => expect(mocks.launchContinuation).toHaveBeenCalled())
    const launched = mocks.launchContinuation.mock.calls[0]?.[0] as { prompt: string }
    expect(buildHandoffPack).toHaveBeenCalledWith({
      agent: 'codex',
      filePath: '/tmp/codex-session.jsonl',
      mode: 'summary'
    })
    expect(launched.prompt).toContain('**user**: wire the widget')
    expect(launched.prompt).not.toContain('available at this path')
  })

  it('keeps the raw-path flow when handing off to the same provider', async () => {
    const buildHandoffPack = vi.fn()
    window.api = { aiVault: { buildHandoffPack } } as never
    mocks.detectAgents.mockResolvedValue(['codex'])
    mocks.launchContinuation.mockResolvedValue(true)

    await act(async () => {
      root.render(
        <AgentSessionContinuationDialog
          open
          request={codexFileRequest('wt-1')}
          onOpenChange={vi.fn()}
        />
      )
    })
    await vi.waitFor(() => expect(container.querySelector('[data-agent="codex"]')).not.toBeNull())

    await act(async () => {
      startButton(container).click()
    })
    await vi.waitFor(() => expect(mocks.launchContinuation).toHaveBeenCalled())
    const launched = mocks.launchContinuation.mock.calls[0]?.[0] as { prompt: string }
    expect(buildHandoffPack).not.toHaveBeenCalled()
    expect(launched.prompt).toContain('available at this path')
  })
})
