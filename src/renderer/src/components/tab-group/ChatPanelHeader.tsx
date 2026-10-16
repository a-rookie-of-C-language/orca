import { X } from 'lucide-react'
import type { Tab } from '../../../../shared/tab-types'
import { resolveUnifiedTabLabel } from '../../../../shared/tab-title-resolution'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent } from '@/lib/agent-status'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

export function ChatPanelHeader({
  chats,
  activeTabId,
  onActivate,
  onClose
}: {
  chats: Tab[]
  activeTabId: string
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
}): React.JSX.Element {
  const generatedTitles = useAppStore((state) => state.settings?.tabAutoGenerateTitle === true)
  const closeLabel = translate('chatPanel.close', 'Close chat')
  const chatLabel = translate('chatPanel.title', 'Chat')
  const active = chats.find((tab) => tab.id === activeTabId)
  return (
    <div
      className="flex h-full min-w-0 items-center gap-2 px-2 [-webkit-app-region:no-drag]"
      data-chat-panel-header=""
    >
      <span
        className="inline-flex shrink-0"
        data-agent-icon={active?.agentSessionAgent}
        aria-hidden="true"
      >
        <AgentIcon agent={agentTypeToIconAgent(active?.agentSessionAgent)} size={14} />
      </span>
      {chats.length > 1 ? (
        <Select value={activeTabId} onValueChange={onActivate}>
          <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label={chatLabel}>
            <SelectValue>
              {active ? resolveUnifiedTabLabel(active, generatedTitles, chatLabel) : chatLabel}
            </SelectValue>
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
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={active?.label}>
          {active ? resolveUnifiedTabLabel(active, generatedTitles, chatLabel) : chatLabel}
        </span>
      )}
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
