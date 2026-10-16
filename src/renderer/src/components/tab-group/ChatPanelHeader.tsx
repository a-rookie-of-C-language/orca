import { MessageSquare, PanelLeft, PanelsTopLeft, X } from 'lucide-react'
import type { Tab } from '../../../../shared/tab-types'
import { resolveUnifiedTabLabel } from '../../../../shared/tab-title-resolution'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

export function DockChatButton({ tabId }: { tabId: string }): React.JSX.Element {
  const dockChatTab = useAppStore((state) => state.dockChatTab)
  const label = translate('chatPanel.dock', 'Dock chat panel')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          onClick={(event) => {
            event.stopPropagation()
            dockChatTab(tabId)
          }}
        >
          <PanelLeft />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function ChatPanelHeader({
  worktreeId,
  groupId,
  chats,
  activeTabId,
  onActivate,
  onClose
}: {
  worktreeId: string
  groupId: string
  chats: Tab[]
  activeTabId: string
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
}): React.JSX.Element {
  const restoreChatTabBar = useAppStore((state) => state.restoreChatTabBar)
  const generatedTitles = useAppStore((state) => state.settings?.tabAutoGenerateTitle === true)
  const restoreLabel = translate('chatPanel.restoreTabs', 'Restore chat tab bar')
  const closeLabel = translate('chatPanel.close', 'Close chat')
  const chatLabel = translate('chatPanel.title', 'Chat')
  const active = chats.find((tab) => tab.id === activeTabId)
  return (
    <div
      className="flex h-full min-w-0 items-center gap-2 px-2 [-webkit-app-region:no-drag]"
      data-chat-panel-header=""
    >
      <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      {chats.length > 1 ? (
        <Select value={activeTabId} onValueChange={onActivate}>
          <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label={chatLabel}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {chats.map((tab) => (
              <SelectItem key={tab.id} value={tab.id}>
                {resolveUnifiedTabLabel(tab, generatedTitles, chatLabel)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={active?.label}>
          {active ? resolveUnifiedTabLabel(active, generatedTitles, chatLabel) : chatLabel}
        </span>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={restoreLabel}
            onClick={() => restoreChatTabBar(worktreeId, groupId)}
          >
            <PanelsTopLeft />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{restoreLabel}</TooltipContent>
      </Tooltip>
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
    </div>
  )
}
