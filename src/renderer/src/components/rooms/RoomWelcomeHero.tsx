import { Bot, Crown, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'

/** Static welcome for empty rooms: explains the Chief pattern, never written to the log. */
export function RoomWelcomeHero(props: {
  roomName: string
  adminName: string | null
  onQuickSend: (text: string) => void
  onSpawnBot: () => void
}) {
  // Why: this memo boundary needs its own language subscription, while
  // translate() preserves Orca's pseudo-localization behavior.
  useTranslation()
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col items-center px-6 py-10 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-card">
        <Crown className="h-5 w-5 text-amber-500" />
      </div>
      <div className="mt-3 text-sm font-semibold">{props.roomName}</div>
      <div className="mt-1 text-xs text-muted-foreground">
        {props.adminName
          ? translate('auto.components.rooms.hero.adminLeads', '{{name}} is the admin here. ', {
              name: props.adminName
            })
          : ''}
        {translate(
          'auto.components.rooms.hero.subtitle',
          'Talk in plain words — the admin calls the right bot for you.'
        )}
      </div>
      <div className="mt-4 grid w-full gap-2 text-left">
        <div className="rounded-lg border border-border/60 bg-card p-3 text-xs leading-relaxed text-muted-foreground">
          <div className="mb-1 font-medium text-foreground">
            {translate('auto.components.rooms.hero.howTitle', 'How rooms work')}
          </div>
          <div>
            {translate(
              'auto.components.rooms.hero.howAdmin',
              '· Your message goes to the admin first.'
            )}
          </div>
          <div>
            {translate(
              'auto.components.rooms.hero.howMention',
              '· Type @Name to call one member directly.'
            )}
          </div>
          <div>
            {translate(
              'auto.components.rooms.hero.howCreate',
              '· Say “create a bot / start a group” and the admin does it.'
            )}
          </div>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => props.onQuickSend('你好，介绍一下你能做什么，可以建 bot 和群聊吗？')}
          >
            <Sparkles className="h-3.5 w-3.5" />{' '}
            {translate('auto.components.rooms.hero.sayHi', 'Say hi')}
          </Button>
          <Button size="sm" variant="outline" onClick={props.onSpawnBot}>
            <Bot className="h-3.5 w-3.5" />{' '}
            {translate('auto.components.rooms.hero.spawnBot', 'Spawn a bot')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => props.onQuickSend('列一下现在有哪些群和 bot，我想开一个新群该怎么说？')}
          >
            {translate('auto.components.rooms.hero.howTo', 'How to use?')}
          </Button>
        </div>
      </div>
    </div>
  )
}
