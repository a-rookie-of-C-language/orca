import { History, MessageSquare, TriangleAlert } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { AgentIcon } from '@/lib/agent-catalog'
import { NATIVE_CHAT_EMPTY_STATE_COPY } from '../../../../shared/native-chat-empty-state'
import type { NativeChatSession } from '../../../../shared/native-chat-types'
import type { NativeChatSessionHistory } from './use-native-chat-session-history'

export function NativeChatEmptyState({
  kind,
  message,
  headline,
  agent,
  retrying = false,
  history
}: {
  kind: 'loading' | 'empty' | 'error' | 'not-agent'
  message?: string
  /** The chat's own sentence for the failure, said once: it takes the generic title's place. */
  headline?: string
  agent?: NativeChatSession['agent']
  /** The read retries on its own (structured chat), so the error says only that it didn't load,
   *  never pointing back to the terminal. */
  retrying?: boolean
  history?: NativeChatSessionHistory
}): React.JSX.Element {
  const copy = emptyStateCopy(kind, { message, headline }, agent, retrying)
  const iconAgent = agentTypeToIconAgent(agent)
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div
        className={
          kind === 'error'
            ? 'flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive'
            : 'flex size-12 items-center justify-center rounded-full bg-accent text-accent-foreground'
        }
      >
        {kind === 'error' ? (
          <TriangleAlert className="size-6" />
        ) : iconAgent ? (
          <span
            className="inline-flex size-6 [&>svg]:size-full [&>img]:size-full"
            data-agent-icon={iconAgent}
            aria-hidden="true"
          >
            <AgentIcon agent={iconAgent} size={24} />
          </span>
        ) : (
          <MessageSquare className="size-6" />
        )}
      </div>
      <p className="text-sm font-medium text-chat-foreground-strong">{copy.title}</p>
      {copy.subtitle ? (
        <p className="max-w-sm text-balance text-xs text-chat-foreground-faint">{copy.subtitle}</p>
      ) : null}
      {kind === 'empty' && history ? <SessionHistoryList history={history} /> : null}
    </div>
  )
}

function SessionHistoryList({ history }: { history: NativeChatSessionHistory }): React.JSX.Element {
  return (
    <div className="mt-2 flex w-full max-w-lg flex-col gap-2 text-left">
      <div className="flex items-center gap-1.5 px-1 text-2xs font-semibold uppercase tracking-wide text-chat-foreground-faint">
        <History className="size-3.5" aria-hidden="true" />
        <span>
          {translate('auto.components.nativeChat.state.empty.recentSessions', 'Recent sessions')}
        </span>
      </div>
      {history.loading && history.items.length === 0 ? (
        <p className="px-1 text-xs text-chat-foreground-faint">
          {translate(
            'auto.components.nativeChat.state.empty.loadingSessions',
            'Looking for saved conversations…'
          )}
        </p>
      ) : null}
      {history.items.length > 0 ? (
        <div
          className="scrollbar-sleek flex max-h-56 flex-col gap-1 overflow-y-auto pr-1"
          role="list"
        >
          {history.items.map((item) => {
            const title = sessionTitle(item.session)
            const preview = sessionPreview(item.session)
            const iconAgent = agentTypeToIconAgent(item.rowAgent)
            return (
              <div key={item.session.id} role="listitem">
                <button
                  type="button"
                  onClick={() => history.resume(item)}
                  className="flex min-h-12 w-full items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {iconAgent ? (
                    <span
                      className="inline-flex size-4 shrink-0 [&>svg]:size-full [&>img]:size-full"
                      data-agent-icon={iconAgent}
                      aria-hidden="true"
                    >
                      <AgentIcon agent={iconAgent} size={16} />
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-chat-foreground-strong">
                        {title}
                      </span>
                      <span className="shrink-0 text-2xs text-chat-foreground-faint">
                        {sessionTimeLabel(item.session.modifiedAt)}
                      </span>
                    </span>
                    {preview ? (
                      <span className="mt-0.5 block truncate text-xs text-chat-foreground-faint">
                        {preview}
                      </span>
                    ) : null}
                  </span>
                </button>
              </div>
            )
          })}
        </div>
      ) : null}
      {history.error && history.items.length === 0 ? (
        <p className="px-1 text-xs text-chat-foreground-faint">{history.error}</p>
      ) : null}
    </div>
  )
}

function sessionTitle(session: NativeChatSessionHistory['items'][number]['session']): string {
  const title = session.title.trim()
  if (title) {
    return title
  }
  return (
    session.previewMessages.find((message) => message.role === 'user')?.text.trim() ??
    translate('auto.components.nativeChat.state.empty.untitledSession', 'Untitled session')
  )
}

function sessionPreview(session: NativeChatSessionHistory['items'][number]['session']): string {
  return (
    session.previewMessages
      .find((message) => message.role === 'user' || message.role === 'assistant')
      ?.text.trim() ?? ''
  )
}

function sessionTimeLabel(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    return ''
  }
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(timestamp)
}

function emptyStateCopy(
  kind: 'loading' | 'empty' | 'error' | 'not-agent',
  words: { message?: string; headline?: string },
  agent?: NativeChatSession['agent'],
  retrying = false
): { title: string; subtitle: string | null } {
  switch (kind) {
    case 'loading':
      return {
        title: translate(
          'components.native-chat.state.loading.title',
          NATIVE_CHAT_EMPTY_STATE_COPY.loading.title
        ),
        subtitle: translate(
          'components.native-chat.state.loading.subtitle',
          NATIVE_CHAT_EMPTY_STATE_COPY.loading.subtitle
        )
      }
    case 'error': {
      if (words.headline) {
        return { title: words.headline, subtitle: null }
      }
      return {
        title: translate(
          'components.native-chat.state.error.title',
          NATIVE_CHAT_EMPTY_STATE_COPY.error.title
        ),
        subtitle: retrying
          ? null
          : (words.message ??
            translate(
              'components.native-chat.state.error.subtitle',
              NATIVE_CHAT_EMPTY_STATE_COPY.error.subtitle
            ))
      }
    }
    case 'not-agent':
      return {
        title: translate(
          'components.native-chat.state.notAgent.title',
          NATIVE_CHAT_EMPTY_STATE_COPY.notAgent.title
        ),
        subtitle: translate(
          'components.native-chat.state.notAgent.subtitle',
          NATIVE_CHAT_EMPTY_STATE_COPY.notAgent.subtitle
        )
      }
    case 'empty': {
      const agentName = agent ? formatAgentTypeLabel(agent) : 'the agent'
      return {
        title: translate(
          'components.native-chat.state.empty.title',
          NATIVE_CHAT_EMPTY_STATE_COPY.empty.title,
          { value0: agentName }
        ),
        subtitle: translate(
          'components.native-chat.state.empty.subtitle',
          NATIVE_CHAT_EMPTY_STATE_COPY.empty.subtitle,
          { value0: agentName }
        )
      }
    }
  }
}
