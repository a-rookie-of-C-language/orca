import React, { useCallback } from 'react'
import { ChevronDown, Copy, Send, X } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { DashboardAgentChildDisclosure } from './DashboardAgentChildDisclosure'

type DashboardAgentRowTrailingControlsProps = {
  childAgentCount?: number
  childAgentsExpanded?: boolean
  onToggleChildAgents?: () => void
  paneKey: string
  relativeTimestamp: string | null
  expanded: boolean
  hideExpand: boolean
  /** dsh session rows name a live pending interaction in the trailing cell
   *  instead of the update time; the caller swaps the text, this flips the tone. */
  isPendingInput?: boolean
  /** Subagent child rows have no store entry of their own to dismiss —
   *  offering the X would be a silent no-op. */
  hideDismiss?: boolean
  sendTargetStatus?: 'eligible' | 'disabled' | 'sending'
  /** Provider session id for the dsh-style Copy Session ID hover button.
   *  Absent on the dashboard and for rows without a provider session. */
  sessionIdForCopy?: string | null
  onCopySessionId?: (sessionId: string) => void
  onDismiss: (paneKey: string) => void
  onToggleExpanded: () => void
  onSendTargetClick?: (paneKey: string) => void
}

export function DashboardAgentRowTrailingControls({
  childAgentCount,
  childAgentsExpanded = false,
  onToggleChildAgents,
  paneKey,
  relativeTimestamp,
  expanded,
  hideExpand,
  isPendingInput = false,
  hideDismiss = false,
  sendTargetStatus,
  sessionIdForCopy,
  onCopySessionId,
  onDismiss,
  onToggleExpanded,
  onSendTargetClick
}: DashboardAgentRowTrailingControlsProps): React.JSX.Element {
  // Why: the copy button rides the same hover reveal as dismiss so the row
  // never shifts — dsh session rows show their hover actions the same way.
  const showCopySessionId = Boolean(sessionIdForCopy && onCopySessionId)
  const handleCopySessionId = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      if (sessionIdForCopy && onCopySessionId) {
        onCopySessionId(sessionIdForCopy)
      }
    },
    [onCopySessionId, sessionIdForCopy]
  )

  // Why: the copy button shares the dismiss hover cell so the row never
  // shifts; without a provider session the dismiss button keeps its exact
  // standalone classes.
  const dismissButton = (inCopyCell: boolean): React.JSX.Element => (
    <button
      type="button"
      onClick={handleDismiss}
      onMouseDown={stopMouseDown}
      onKeyDown={stopKeyDown}
      className={cn(
        !inCopyCell && '[grid-area:1/1]',
        'inline-flex items-center justify-center text-muted-foreground/70 hover:text-foreground',
        'can-hover:opacity-0 transition-opacity duration-150',
        'group-hover/agent-row:opacity-100 focus-visible:opacity-100'
      )}
      aria-label={translate(
        'auto.components.dashboard.DashboardAgentRow.b06e13fcf7',
        'Dismiss agent'
      )}
      title={translate('auto.components.dashboard.DashboardAgentRow.5ae84475cc', 'Dismiss')}
    >
      <X className="size-3.5" />
    </button>
  )
  // Why: stop propagation so clicking nested row controls does not also
  // activate the agent row or parent worktree card.
  const stopMouseDown = useCallback((event: React.MouseEvent) => {
    event.stopPropagation()
  }, [])
  const stopKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.stopPropagation()
    }
  }, [])
  const handleDismiss = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation()
      onDismiss(paneKey)
    },
    [onDismiss, paneKey]
  )
  const handleToggleExpand = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      onToggleExpanded()
    },
    [onToggleExpanded]
  )
  const handleInlineSendTargetClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      if (sendTargetStatus === 'eligible') {
        onSendTargetClick?.(paneKey)
      }
    },
    [onSendTargetClick, paneKey, sendTargetStatus]
  )

  const hasChildDisclosure = Boolean(childAgentCount && onToggleChildAgents)

  return (
    <span
      className={cn(
        // Reserve the disclosure height even when there are no children.
        'relative ml-auto flex h-5 shrink-0 items-center justify-end',
        hasChildDisclosure ? 'gap-1' : 'w-12'
      )}
    >
      {(sendTargetStatus === 'eligible' || sendTargetStatus === 'sending') && (
        <button
          type="button"
          onClick={handleInlineSendTargetClick}
          onMouseDown={stopMouseDown}
          onKeyDown={stopKeyDown}
          disabled={sendTargetStatus === 'sending'}
          className={cn(
            'worktree-agent-send-target-button absolute right-0 top-1/2 z-10 inline-flex h-5 -translate-y-1/2 items-center gap-1 rounded-md border px-1.5 text-[10px] font-medium leading-none transition-[background-color,border-color,color,opacity]',
            hasChildDisclosure && 'static translate-y-0',
            sendTargetStatus === 'sending' && 'cursor-progress opacity-75'
          )}
          aria-label={translate(
            'auto.components.dashboard.DashboardAgentRow.0272969e28',
            'Send to this agent'
          )}
          title={translate(
            'auto.components.dashboard.DashboardAgentRow.0272969e28',
            'Send to this agent'
          )}
        >
          <Send className="size-3" />
          <span>{translate('auto.components.dashboard.DashboardAgentRow.912e136cd9', 'Send')}</span>
        </button>
      )}
      {!hasChildDisclosure && !sendTargetStatus && hideDismiss && relativeTimestamp !== null && (
        <span
          className={cn(
            'pointer-events-none shrink-0 text-[10px] leading-none',
            isPendingInput ? 'text-agent-question' : 'text-muted-foreground/60'
          )}
          aria-hidden
        >
          {relativeTimestamp}
        </span>
      )}
      {/* Why: timestamp and dismiss-X share one slot. On no-hover devices the X
          is visible by default, so the timestamp must yield there too. */}
      {!hasChildDisclosure && !sendTargetStatus && !hideDismiss && relativeTimestamp !== null && (
        <span className="relative grid grid-cols-1 grid-rows-1 shrink-0 items-center justify-items-end">
          <span
            className={cn(
              '[grid-area:1/1] pointer-events-none text-[10px] leading-none',
              isPendingInput ? 'text-agent-question' : 'text-muted-foreground/60',
              'transition-opacity duration-150',
              'group-hover/agent-row:opacity-0 [@media(hover:none)]:opacity-0'
            )}
            aria-hidden
          >
            {relativeTimestamp}
          </span>
          {showCopySessionId ? (
            <span className="[grid-area:1/1] inline-flex items-center justify-end">
              <button
                type="button"
                onClick={handleCopySessionId}
                onMouseDown={stopMouseDown}
                onKeyDown={stopKeyDown}
                className={cn(
                  'inline-flex items-center justify-center text-muted-foreground/70 hover:text-foreground',
                  'can-hover:opacity-0 transition-opacity duration-150',
                  'group-hover/agent-row:opacity-100 focus-visible:opacity-100'
                )}
                aria-label={translate(
                  'auto.components.dashboard.DashboardAgentRow.copySessionId',
                  'Copy session ID'
                )}
                title={translate(
                  'auto.components.dashboard.DashboardAgentRow.copySessionId',
                  'Copy session ID'
                )}
              >
                <Copy className="size-3.5" />
              </button>
              {dismissButton(true)}
            </span>
          ) : (
            dismissButton(false)
          )}
        </span>
      )}
      {!sendTargetStatus && !hideDismiss && (hasChildDisclosure || relativeTimestamp === null) && (
        <button
          type="button"
          onClick={handleDismiss}
          onMouseDown={stopMouseDown}
          onKeyDown={stopKeyDown}
          className={cn(
            'inline-flex shrink-0 items-center justify-center text-muted-foreground/70 hover:text-foreground',
            'can-hover:opacity-0 transition-opacity duration-150',
            'group-hover/agent-row:opacity-100 focus-visible:opacity-100'
          )}
          aria-label={translate(
            'auto.components.dashboard.DashboardAgentRow.b06e13fcf7',
            'Dismiss agent'
          )}
          title={translate('auto.components.dashboard.DashboardAgentRow.5ae84475cc', 'Dismiss')}
        >
          <X className="size-3.5" />
        </button>
      )}
      {hasChildDisclosure && (
        <DashboardAgentChildDisclosure
          childAgentCount={childAgentCount}
          childAgentsExpanded={childAgentsExpanded}
          onToggleChildAgents={onToggleChildAgents}
          timestamp={
            <span
              className={cn(
                'text-[10px] leading-none',
                isPendingInput ? 'text-agent-question' : 'text-muted-foreground/60'
              )}
            >
              {relativeTimestamp}
            </span>
          }
        />
      )}
      {!hideExpand && (
        <button
          type="button"
          onClick={handleToggleExpand}
          onMouseDown={stopMouseDown}
          onKeyDown={stopKeyDown}
          className="inline-flex shrink-0 items-center justify-center text-muted-foreground/60 hover:text-foreground"
          aria-label={
            expanded
              ? translate(
                  'auto.components.dashboard.DashboardAgentRow.a41fb5376e',
                  'Collapse details'
                )
              : translate(
                  'auto.components.dashboard.DashboardAgentRow.a743da52ff',
                  'Expand details'
                )
          }
          aria-expanded={expanded}
        >
          <ChevronDown
            className={cn('size-3.5 transition-transform duration-150', expanded && 'rotate-180')}
          />
        </button>
      )}
    </span>
  )
}
