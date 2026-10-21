import { useEffect, useState } from 'react'
import { Bot, Loader2, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useActiveWorktreeId, useAllWorktrees } from '@/store/selectors'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { BOT_AGENTS, LOCAL } from './room-types'
import { readAgentModels, type CatalogModel } from './room-model-catalog'

/** Spawn a new structured agent session into this room as a member. */
export function SpawnBotForm(props: {
  roomId: string
  onSpawned: () => void
  onCancel: () => void
}) {
  // Why: this memo boundary needs its own language subscription, while
  // translate() preserves Orca's pseudo-localization behavior.
  useTranslation()
  const worktrees = useAllWorktrees()
  const activeWorktreeId = useActiveWorktreeId()
  const [name, setName] = useState('')
  const [agent, setAgent] = useState<string>('codex')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [worktreeId, setWorktreeId] = useState<string>(activeWorktreeId ?? '')
  const [instructions, setInstructions] = useState('')
  const [busy, setBusy] = useState(false)
  const [models, setModels] = useState<CatalogModel[]>([])

  useEffect(() => {
    if (!worktreeId && worktrees.length > 0) {
      setWorktreeId(worktrees[0].id)
    }
  }, [worktreeId, worktrees])

  useEffect(() => {
    if (!worktreeId) {
      return
    }
    let live = true
    void readAgentModels(agent, worktreeId).then((listed) => {
      if (live) {
        setModels(listed)
      }
    })
    return () => {
      live = false
    }
  }, [agent, worktreeId])

  const submit = async () => {
    if (!name.trim()) {
      toast.error(translate('auto.components.rooms.spawnBot.needsName', 'Bot needs a name'))
      return
    }
    if (!worktreeId) {
      toast.error(
        translate('auto.components.rooms.spawnBot.pickWorkspace', 'Pick a workspace for the bot')
      )
      return
    }
    setBusy(true)
    try {
      await callRuntimeRpc(LOCAL, 'orchestration.roomBotCreate', {
        id: props.roomId,
        worktree: `id:${worktreeId}`,
        agent,
        model: model.trim() || undefined,
        effort: effort || undefined,
        name: name.trim(),
        instructions: instructions.trim() || undefined
      })
      toast.success(
        translate('auto.components.rooms.spawnBot.joined', 'Bot "{{name}}" joined the room', {
          name: name.trim()
        })
      )
      props.onSpawned()
    } catch (error) {
      toast.error(
        `${translate('auto.components.rooms.spawnBot.failed', 'Failed to spawn bot')}: ${(error as Error).message}`
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-2 rounded-md border border-border/60 bg-card p-3">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Bot className="h-3.5 w-3.5" />{' '}
        {translate('auto.components.rooms.spawnBot.title', 'New bot')}
      </div>
      <Input
        placeholder={translate(
          'auto.components.rooms.spawnBot.namePlaceholder',
          'Name (e.g. reviewer, planner)'
        )}
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={busy}
      />
      <div className="grid grid-cols-2 gap-2">
        <select
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
          disabled={busy}
        >
          {BOT_AGENTS.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        <select
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          value={worktreeId}
          onChange={(e) => setWorktreeId(e.target.value)}
          disabled={busy}
        >
          {worktrees.length === 0 ? (
            <option value="">
              {translate('auto.components.rooms.spawnBot.noWorkspace', '(no workspace)')}
            </option>
          ) : null}
          {worktrees.map((w) => (
            <option key={w.id} value={w.id}>
              {w.displayName}
            </option>
          ))}
        </select>
      </div>
      {models.length > 0 ? (
        <select
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          value={model}
          onChange={(e) => {
            setModel(e.target.value)
            setEffort('')
          }}
          disabled={busy}
        >
          <option value="">
            {translate('auto.components.rooms.spawnBot.modelDefault', '(agent default)')}
          </option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      ) : (
        <Input
          placeholder={translate(
            'auto.components.rooms.spawnBot.modelPlaceholder',
            'Model (optional, e.g. gpt-5.2-codex / opus)'
          )}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={busy}
        />
      )}
      {(() => {
        const picked = models.find((m) => m.id === model)
            if (!picked || picked.efforts.length === 0) {
              return null
            }
        return (
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={effort}
            onChange={(e) => setEffort(e.target.value)}
            disabled={busy}
          >
            <option value="">
              {translate('auto.components.rooms.spawnBot.effortDefault', '(default thinking)')}
            </option>
            {picked.efforts.map((e) => (
              <option key={e.value} value={e.value}>
                {e.label}
              </option>
            ))}
          </select>
        )
      })()}
      <Input
        placeholder={translate(
          'auto.components.rooms.spawnBot.instructionsPlaceholder',
          'Role / instructions (optional)'
        )}
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        disabled={busy}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={props.onCancel} disabled={busy}>
          {translate('auto.components.rooms.spawnBot.cancel', 'Cancel')}
        </Button>
        <Button size="sm" onClick={() => void submit()} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {translate('auto.components.rooms.spawnBot.spawn', 'Spawn')}
        </Button>
      </div>
    </div>
  )
}
