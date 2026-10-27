import { Bot, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { QuickLaunchAgentMenuItems } from '@/components/tab-bar/QuickLaunchButton'
import { activateNativeChatAgentLaunchTab } from '@/lib/activate-native-chat-agent-launch-tab'
import { useAppStore } from '@/store'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { useNativeChatTabOwnerWorktreeId } from './use-native-chat-tab-owner'
import type { AgentType } from '../../../../shared/agent-status-types'

export type NativeChatAgentLaunchMenuProps = {
  terminalTabId: string
  agent?: AgentType
}

/** Starts another agent in the chat's workspace without replacing the current conversation. */
export function NativeChatAgentLaunchMenu({
  terminalTabId,
  agent
}: NativeChatAgentLaunchMenuProps): React.JSX.Element | null {
  const worktreeId = useNativeChatTabOwnerWorktreeId(terminalTabId)
  const label = translate(
    'components.native-chat.composer.startAnotherAgent',
    'Start another agent'
  )
  const iconAgent = agentTypeToIconAgent(agent)
  if (!worktreeId) {
    return null
  }

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="xs" aria-label={label} className="max-w-36">
              {iconAgent ? <AgentIcon agent={iconAgent} size={14} /> : <Bot className="size-4" />}
              <span className="min-w-0 truncate">{formatAgentTypeLabel(agent)}</span>
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" side="top" className="w-56">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {(() => {
          const state = useAppStore.getState()
          const groupId =
            state.getTab(terminalTabId)?.groupId ??
            state.activeGroupIdByWorktree[worktreeId] ??
            state.groupsByWorktree[worktreeId]?.[0]?.id
          return groupId ? (
            <QuickLaunchAgentMenuItems
              worktreeId={worktreeId}
              groupId={groupId}
              onFocusTerminal={activateNativeChatAgentLaunchTab}
              onFocusChat={activateNativeChatAgentLaunchTab}
              launchSource="native_chat"
            />
          ) : null
        })()}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
