// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { GitHistoryItemViewModel } from '../../../../../../shared/git-history-graph'
import { GitHistoryRow } from './git-history-row'

const subject = 'Fix retained agent exits'
const message = `${subject}\n\nRetire exits only after their owning session ends.`

function viewModel(commitMessage = message): GitHistoryItemViewModel {
  return {
    historyItem: { id: 'abc123', parentIds: [], subject, message: commitMessage },
    kind: 'node',
    inputSwimlanes: [],
    outputSwimlanes: []
  }
}

afterEach(cleanup)

describe('Git history commit details', () => {
  it('uses a theme-aware hover card for the full commit message', async () => {
    render(
      <TooltipProvider>
        <GitHistoryRow viewModel={viewModel()} />
      </TooltipProvider>
    )

    fireEvent.pointerEnter(screen.getByText(subject), { pointerType: 'mouse' })

    await waitFor(() => {
      const preview = document.querySelector('[data-slot="hover-card-content"]')
      expect(preview?.textContent).toBe(message)
      expect(preview?.classList.contains('text-popover-foreground')).toBe(true)
      expect(preview?.classList.contains('overflow-y-auto')).toBe(true)
      expect(preview?.classList.contains('whitespace-pre-wrap')).toBe(true)
      expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull()
    })
  })

  it('falls back to the subject when a commit has no message', async () => {
    render(
      <TooltipProvider>
        <GitHistoryRow viewModel={viewModel('')} />
      </TooltipProvider>
    )

    fireEvent.pointerEnter(screen.getByText(subject), { pointerType: 'mouse' })

    await waitFor(() => {
      expect(document.querySelector('[data-slot="hover-card-content"]')?.textContent).toBe(subject)
    })
  })

  it('still expands files instead of opening the combined diff on a row click', () => {
    const onToggleExpand = vi.fn()
    const onOpenCommit = vi.fn()
    const model = viewModel()
    render(
      <TooltipProvider>
        <GitHistoryRow
          viewModel={model}
          onToggleExpand={onToggleExpand}
          onOpenCommit={onOpenCommit}
        />
      </TooltipProvider>
    )

    fireEvent.click(screen.getByRole('button'))

    expect(onToggleExpand).toHaveBeenCalledExactlyOnceWith(model.historyItem)
    expect(onOpenCommit).not.toHaveBeenCalled()
  })

  it('does not expand the row when selecting the preview text', async () => {
    const onToggleExpand = vi.fn()
    render(
      <TooltipProvider>
        <GitHistoryRow viewModel={viewModel()} onToggleExpand={onToggleExpand} />
      </TooltipProvider>
    )

    fireEvent.pointerEnter(screen.getByText(subject), { pointerType: 'mouse' })
    const preview = await waitFor(() => {
      const content = document.querySelector('[data-slot="hover-card-content"]')
      expect(content).not.toBeNull()
      if (!content) {
        throw new Error('Commit preview did not open')
      }
      return content
    })
    fireEvent.click(preview)

    expect(onToggleExpand).not.toHaveBeenCalled()
  })
})
