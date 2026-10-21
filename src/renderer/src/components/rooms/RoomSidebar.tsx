import { Loader2, Crown, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type { AgentSessionOption, Room } from './room-types'
import { CreateRoomDialog } from './CreateRoomDialog'

/** Quiet room list; creation lives in a dialog so the sidebar never shouts. */
export function RoomSidebar(props: {
  rooms: Room[]
  loading: boolean
  selectedId: string | null
  pool: AgentSessionOption[]
  onSelect: (id: string) => void
  onRefresh: () => void
  onCreated: () => void
}) {
  // Why: this memo boundary needs its own language subscription, while
  // translate() preserves Orca's pseudo-localization behavior.
  useTranslation()
  const closeRoomsPage = useAppStore((s) => s.closeRoomsPage)
  return (
    <aside className="flex w-64 flex-col border-r border-border/60 bg-card/20">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
        <div className="text-sm font-semibold">
          {translate('auto.components.rooms.page.title', 'Bots')}
        </div>
        <div className="flex gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={props.onRefresh}
                aria-label={translate('auto.components.rooms.page.refresh', 'Refresh rooms')}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.components.rooms.page.refresh', 'Refresh rooms')}
            </TooltipContent>
          </Tooltip>
          <Button variant="ghost" size="sm" onClick={closeRoomsPage}>
            {translate('auto.components.rooms.page.close', 'Close')}
          </Button>
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-1 p-2">
          {props.loading ? (
            <div className="flex items-center gap-2 px-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />{' '}
              {translate('auto.components.rooms.page.loading', 'Loading…')}
            </div>
          ) : props.rooms.length === 0 ? (
            <div className="px-2 py-4 text-sm text-muted-foreground">
              {translate('auto.components.rooms.page.noRooms', 'No rooms yet.')}
            </div>
          ) : (
            props.rooms.map((room) => {
              const admin = room.members.find((m) => m.isAdmin)?.name
              const active = props.selectedId === room.id
              return (
                <button
                  key={room.id}
                  type="button"
                  onClick={() => props.onSelect(room.id)}
                  className={cn(
                    'w-full rounded-md px-3 py-2 text-left text-sm hover:bg-accent/50',
                    active && 'bg-accent text-accent-foreground'
                  )}
                >
                  <div className="flex items-center gap-1.5 font-medium">
                    {room.name === 'Orca HQ' ? (
                      <Crown className="h-3.5 w-3.5 text-amber-500" />
                    ) : null}
                    <span className="truncate">{room.name}</span>
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {admin ? `${admin} · ` : ''}
                    {translate(
                      'auto.components.rooms.page.memberCount',
                      '{{count}} member{{plural}}',
                      { count: room.members.length, plural: room.members.length === 1 ? '' : 's' }
                    )}
                  </div>
                </button>
              )
            })
          )}
        </div>
      </ScrollArea>
      <div className="border-t border-border/60 p-2">
        <CreateRoomDialog pool={props.pool} onCreated={props.onCreated} />
        <div className="mt-1.5 px-1 text-[11px] leading-relaxed text-muted-foreground">
          {translate(
            'auto.components.rooms.page.tip',
            'Tip: talk to Orca Admin in Orca HQ — just say what group or bot you want.'
          )}
        </div>
      </div>
    </aside>
  )
}
