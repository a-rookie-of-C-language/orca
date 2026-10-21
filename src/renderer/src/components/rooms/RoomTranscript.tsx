import type { RefObject } from 'react'
import { Crown } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { Room, RoomLine } from './room-types'
import { RoomWelcomeHero } from './RoomWelcomeHero'

/** Room messages as quiet bubbles; empty rooms show the welcome hero. */
export function RoomTranscript(props: {
  selected: Room
  lines: RoomLine[]
  adminName: string | null
  bottomRef: RefObject<HTMLDivElement | null>
  onQuickSend: (text: string) => void
  onSpawnBot: () => void
}) {
  const { selected, lines } = props
  return (
    <ScrollArea className="flex-1">
      <div className="space-y-3 p-4">
        {lines.length === 0 ? (
          <RoomWelcomeHero
            roomName={selected.name}
            adminName={props.adminName}
            onQuickSend={props.onQuickSend}
            onSpawnBot={props.onSpawnBot}
          />
        ) : (
          lines.map((line) => {
            const isUser = !line.memberId
            const isFailed = line.kind === 'failed'
            const isAdminLine = selected.members.some(
              (m) => m.memberId === line.memberId && m.isAdmin
            )
            return (
              <div key={line.seq} className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
                <div
                  className={cn(
                    'max-w-[78%] rounded-xl px-3 py-2 text-sm',
                    isUser
                      ? 'bg-accent text-accent-foreground'
                      : 'border border-border/60 bg-card text-card-foreground',
                    isFailed && 'border-destructive/60'
                  )}
                >
                  <div className="mb-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                    {isAdminLine ? <Crown className="h-3 w-3 text-amber-500" /> : null}
                    <span className="font-medium">{line.who}</span>
                    {line.kind ? <span>[{line.kind}]</span> : null}
                  </div>
                  <div className="whitespace-pre-wrap break-words leading-relaxed">{line.text}</div>
                </div>
              </div>
            )
          })
        )}
        <div ref={props.bottomRef} />
      </div>
    </ScrollArea>
  )
}
