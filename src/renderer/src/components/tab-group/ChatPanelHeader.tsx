import { Pencil, X } from 'lucide-react'
import type { Tab } from '../../../../shared/tab-types'
import { resolveUnifiedTabLabel } from '../../../../shared/tab-title-resolution'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent } from '@/lib/agent-status'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import { ImeInput } from '@/lib/ime-text-field'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { useSortableTabRename } from '../tab-bar/use-sortable-tab-rename'

export function ChatPanelHeader({
  chats,
  activeTabId,
  onActivate,
  onClose,
  allowClose = true
}: {
  chats: Tab[]
  activeTabId: string
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  /** False hides the close button so a pinned column keeps its last chat. */
  allowClose?: boolean
}): React.JSX.Element {
  const generatedTitles = useAppStore((state) => state.settings?.tabAutoGenerateTitle === true)
  const setTabCustomTitle = useAppStore((state) => state.setTabCustomTitle)
  const closeLabel = translate('chatPanel.close', 'Close chat')
  const chatLabel = translate('chatPanel.title', 'Chat')
  const renameLabel = translate('chatPanel.rename', 'Rename chat')
  const active = chats.find((tab) => tab.id === activeTabId)
  return (
    <div
      className="flex h-full min-w-0 items-center gap-2 px-2 [-webkit-app-region:no-drag]"
      data-chat-panel-header=""
      data-chat-panel-active-tab-id={activeTabId}
    >
      <span
        className="inline-flex shrink-0"
        data-agent-icon={active?.agentSessionAgent}
        aria-hidden="true"
      >
        <AgentIcon agent={agentTypeToIconAgent(active?.agentSessionAgent)} size={14} />
      </span>
      {active ? (
        <ChatPanelTitle
          key={active.id}
          active={active}
          chats={chats}
          generatedTitles={generatedTitles}
          chatLabel={chatLabel}
          renameLabel={renameLabel}
          onActivate={onActivate}
          onSetCustomTitle={setTabCustomTitle}
        />
      ) : (
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{chatLabel}</span>
      )}
      {allowClose ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={closeLabel}
              onClick={() => onClose(activeTabId)}
            >
              <X />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{closeLabel}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  )
}

function ChatPanelTitle({
  active,
  chats,
  generatedTitles,
  chatLabel,
  renameLabel,
  onActivate,
  onSetCustomTitle
}: {
  active: Tab
  chats: Tab[]
  generatedTitles: boolean
  chatLabel: string
  renameLabel: string
  onActivate: (tabId: string) => void
  onSetCustomTitle: (tabId: string, title: string | null) => void
}): React.JSX.Element {
  const displayTitle = resolveUnifiedTabLabel(active, generatedTitles, chatLabel)
  const {
    isEditing,
    renameValue,
    setRenameValue,
    handleRenameOpen,
    commitRename,
    cancelRename,
    setRenameInputElement
  } = useSortableTabRename({
    tabId: active.id,
    title: displayTitle,
    customTitle: active.customLabel,
    onSetCustomTitle
  })

  return (
    <>
      {isEditing ? (
        // Inline title editor: same type and position as the static title, no box
        // chrome; caret plus text selection carries the editing affordance.
        <ImeInput
          ref={setRenameInputElement}
          data-tab-rename-input="true"
          data-chat-rename-input="true"
          value={renameValue}
          aria-label={renameLabel}
          onChange={(event) => setRenameValue(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (isImeCompositionKeyDown(event)) {
              return
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              commitRename()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              cancelRename()
            }
          }}
          className="h-6 min-w-0 flex-1 truncate bg-transparent px-0 text-xs font-medium text-foreground caret-primary outline-none selection:bg-primary/20 placeholder:text-muted-foreground/50 focus-visible:outline-none"
          spellCheck={false}
        />
      ) : chats.length > 1 ? (
        <Select value={active.id} onValueChange={onActivate}>
          <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label={chatLabel}>
            <SelectValue>{displayTitle}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {chats.map((tab) => (
              <SelectItem key={tab.id} value={tab.id}>
                <span
                  className="inline-flex shrink-0"
                  data-agent-icon={tab.agentSessionAgent}
                  aria-hidden="true"
                >
                  <AgentIcon agent={agentTypeToIconAgent(tab.agentSessionAgent)} size={14} />
                </span>
                {resolveUnifiedTabLabel(tab, generatedTitles, chatLabel)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={displayTitle}>
          {displayTitle}
        </span>
      )}
      {isEditing ? null : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={renameLabel}
              onClick={handleRenameOpen}
            >
              <Pencil />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{renameLabel}</TooltipContent>
        </Tooltip>
      )}
    </>
  )
}
