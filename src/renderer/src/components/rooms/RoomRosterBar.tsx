import { Bot, Crown, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { AgentSessionOption, Room } from './room-types'
import { shortSessionLabel } from './room-session-pool'
import { SpawnBotForm } from './SpawnBotForm'

/** Member chips plus the collapsible spawn-bot and add-member panels. */
export function RoomRosterBar(props: {
  selected: Room
  spawnOpen: boolean
  addOpen: boolean
  poolAvailable: AgentSessionOption[]
  worktreeNames: Map<string, string>
  onSpawned: () => void
  onCancelSpawn: () => void
  onAddMember: (sessionId: string, isAdmin: boolean) => void
  onRemoveMember: (memberId: string) => void
}) {
  // Why: this memo boundary needs its own language subscription, while
  // translate() preserves Orca's pseudo-localization behavior.
  useTranslation()
  const { selected } = props
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-4 py-2">
        {selected.members.length === 0 ? (
          <span className="text-xs text-muted-foreground">
            {translate('auto.components.rooms.page.noMembers', 'No members — spawn a bot above.')}
          </span>
        ) : (
          selected.members.map((m) => (
            <span
              key={m.memberId}
              className={cn(
                'group inline-flex max-w-44 items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
                m.isAdmin ? 'border-amber-500/50 bg-amber-500/10' : 'border-border/60'
              )}
            >
              {m.isAdmin ? (
                <Crown className="h-3 w-3 shrink-0 text-amber-500" />
              ) : (
                <Bot className="h-3 w-3 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{m.name}</span>
              <button
                type="button"
                onClick={() => props.onRemoveMember(m.memberId)}
                className="ml-0.5 hidden shrink-0 rounded-full p-0.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive group-hover:inline-flex"
                aria-label={translate(
                  'auto.components.rooms.page.removeMember',
                  'Remove {{name}}',
                  {
                    name: m.name
                  }
                )}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))
        )}
      </div>
      {props.spawnOpen ? (
        <div className="border-b border-border/60 px-4 py-2">
          <SpawnBotForm
            roomId={selected.id}
            onSpawned={props.onSpawned}
            onCancel={props.onCancelSpawn}
          />
        </div>
      ) : null}
      {props.addOpen ? (
        <div className="space-y-1.5 border-b border-border/60 px-4 py-2">
          <div className="text-xs font-medium text-muted-foreground">
            {translate('auto.components.rooms.page.addMember', 'Add member')}
          </div>
          <div className="max-h-28 space-y-0.5 overflow-y-auto scrollbar-sleek">
            {props.poolAvailable.length === 0 ? (
              <div className="text-xs text-muted-foreground/70">
                {translate(
                  'auto.components.rooms.page.allSessionsAdded',
                  'All open agent sessions are already in this room.'
                )}
              </div>
            ) : (
              props.poolAvailable.map((opt) => (
                <div
                  key={opt.sessionId}
                  className="flex items-center justify-between gap-2 rounded px-2 py-1 hover:bg-accent/40"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs">{shortSessionLabel(opt.label)}</span>
                    <span className="block truncate text-[11px] text-muted-foreground/70">
                      {props.worktreeNames.get(opt.worktreeId) ?? ''}
                    </span>
                  </span>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => props.onAddMember(opt.sessionId, false)}
                    >
                      {translate('auto.components.rooms.page.add', 'Add')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => props.onAddMember(opt.sessionId, true)}
                    >
                      {translate('auto.components.rooms.page.addAsAdmin', 'Admin')}
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </>
  )
}
