import { Loader2, SendHorizonal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/** Composer with @-mention completion and delivery-status slots. */
export function RoomComposer(props: {
  composer: string
  sending: boolean
  lastSlots: { name: string; status: string }[]
  mentionOptions: string[]
  mentionQuery: string | null
  onComposerChange: (value: string) => void
  onApplyMention: (name: string) => void
  onSend: () => void
}) {
  // Why: this memo boundary needs its own language subscription, while
  // translate() preserves Orca's pseudo-localization behavior.
  useTranslation()
  const { mentionOptions, mentionQuery } = props
  return (
    <footer className="border-t border-border/60 p-3">
      {props.lastSlots.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
          {props.lastSlots.map((s) => (
            <span
              key={s.name}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5',
                s.status === 'failed' && 'border-destructive/60 text-destructive'
              )}
            >
              {s.status === 'working' || s.status === 'speaking' ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : null}
              {s.name}:{' '}
              {s.status === 'working'
                ? translate('auto.components.rooms.page.workingOnIt', 'working on it')
                : s.status}
            </span>
          ))}
        </div>
      ) : null}
      {mentionOptions.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1">
          {mentionOptions.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => props.onApplyMention(name)}
              className="rounded-full border border-border/60 bg-accent/50 px-2 py-0.5 text-xs hover:bg-accent"
            >
              @{name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex gap-2">
        <Input
          placeholder={translate(
            'auto.components.rooms.page.composerPlaceholder',
            'Message… @Name to call one, @all (admin only) for everyone'
          )}
          value={props.composer}
          onChange={(e) => props.onComposerChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              if (mentionOptions.length > 0 && mentionQuery !== null && mentionQuery.length > 0) {
                e.preventDefault()
                props.onApplyMention(mentionOptions[0])
                return
              }
              e.preventDefault()
              props.onSend()
            }
            if (e.key === 'Tab' && mentionOptions.length > 0) {
              e.preventDefault()
              props.onApplyMention(mentionOptions[0])
            }
            if (e.key === 'Escape' && mentionOptions.length > 0) {
              props.onComposerChange(props.composer.replace(/@([\w\u4e00-\u9fa5]*)$/, ''))
            }
          }}
          disabled={props.sending}
        />
        <Button onClick={props.onSend} disabled={props.sending || !props.composer.trim()}>
          {props.sending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <SendHorizonal className="h-4 w-4" />
          )}
          {translate('auto.components.rooms.page.send', 'Send')}
        </Button>
      </div>
    </footer>
  )
}
