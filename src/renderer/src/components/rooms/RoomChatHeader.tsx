import { Bot, Crown, Trash2, UserPlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Room } from './room-types'

/** Room title row: name, mode, admin, and the spawn / add / delete actions. */
export function RoomChatHeader(props: {
  selected: Room
  adminName: string | null
  onToggleSpawn: () => void
  onToggleAdd: () => void
  onDelete: () => void
}) {
  // Why: this memo boundary needs its own language subscription, while
  // translate() preserves Orca's pseudo-localization behavior.
  useTranslation()
  const { selected, adminName } = props
  return (
    <header className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 font-semibold">
          {selected.name === 'Orca HQ' ? <Crown className="h-4 w-4 text-amber-500" /> : null}
          <span className="truncate">{selected.name}</span>
          <span className="shrink-0 rounded-full border border-border/60 px-1.5 py-px text-[11px] text-muted-foreground">
            {selected.mode}
          </span>
        </div>
        {adminName ? (
          <div className="truncate text-xs text-muted-foreground">
            {translate('auto.components.rooms.page.adminLabel', 'admin: {{name}}', {
              name: adminName
            })}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={props.onToggleSpawn}
              aria-label={translate(
                'auto.components.rooms.page.spawnBot',
                'Spawn a bot into this room'
              )}
            >
              <Bot className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.components.rooms.page.spawnBot', 'Spawn a bot into this room')}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={props.onToggleAdd}
              aria-label={translate('auto.components.rooms.page.addMember', 'Add member')}
            >
              <UserPlus className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.components.rooms.page.addMember', 'Add member')}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={props.onDelete}
              aria-label={translate('auto.components.rooms.page.deleteRoom', 'Delete room')}
            >
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.components.rooms.page.deleteRoom', 'Delete room')}
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  )
}
