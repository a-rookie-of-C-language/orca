/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CompactAgentRow } from './worktree-card-compact-agent-row'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

vi.mock('@/components/dashboard/use-agent-row-conversation-name', () => ({
  useAgentRowConversationName: () => null
}))

vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownForPane: () => null
}))

function makeAgent(): DashboardAgentRowData {
  const paneKey = 'tab-1:leaf-1'
  const tab: TerminalTab = {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
  const entry: AgentStatusEntry = {
    state: 'done',
    prompt: 'do the task',
    updatedAt: 500,
    stateStartedAt: 500,
    agentType: 'claude',
    paneKey,
    stateHistory: [],
    lastAssistantMessage: 'finished'
  }
  return {
    paneKey,
    entry,
    tab,
    agentType: 'claude',
    state: 'done',
    startedAt: 500
  }
}

let root: Root | undefined

afterEach(() => {
  act(() => root?.unmount())
  document.body.replaceChildren()
})

function renderRow({
  sessionIdForCopy,
  onCopySessionId,
  onActivate,
  agent
}: {
  sessionIdForCopy?: string | null
  onCopySessionId?: (sessionId: string) => void
  onActivate?: () => void
  agent?: DashboardAgentRowData
}): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <TooltipProvider>
        <CompactAgentRow
          agent={agent ?? makeAgent()}
          now={2000}
          onActivate={onActivate ?? (() => {})}
          sessionIdForCopy={sessionIdForCopy}
          onCopySessionId={onCopySessionId}
        />
      </TooltipProvider>
    )
  })
  return container
}

function copyButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('[aria-label="Copy session ID"]')
}

describe('CompactAgentRow copy session ID', () => {
  it('copies the provider session without activating the row', () => {
    const onCopySessionId = vi.fn()
    const onActivate = vi.fn()
    const container = renderRow({ sessionIdForCopy: 'sess-123', onCopySessionId, onActivate })

    const button = copyButton(container)
    expect(button).not.toBeNull()
    act(() => {
      button!.click()
    })

    expect(onCopySessionId).toHaveBeenCalledTimes(1)
    expect(onCopySessionId).toHaveBeenCalledWith('sess-123')
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('renders no copy target without a provider session, keeping the timestamp', () => {
    const container = renderRow({ onCopySessionId: vi.fn() })

    expect(copyButton(container)).toBeNull()
    expect(container.querySelector('.compact-agent-row')).not.toBeNull()
  })

  it('names a pending question in the trailing cell instead of the update time', () => {
    const agent = makeAgent()
    agent.state = 'waiting'
    agent.entry = { ...agent.entry, state: 'waiting', lastAssistantMessage: undefined }
    const container = renderRow({ agent })

    expect(container.textContent).toContain('Waiting for input')
  })

  it('names a blocked row in the trailing cell instead of the update time', () => {
    const agent = makeAgent()
    agent.state = 'blocked'
    agent.entry = { ...agent.entry, state: 'blocked', lastAssistantMessage: undefined }
    const container = renderRow({ agent })

    expect(container.textContent).toContain('Blocked')
  })
})
