import { useEffect, useMemo, useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import { useActiveWorktreeId, useAllWorktrees } from '@/store/selectors'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { LOCAL, ORCA_SESSION_PREFIX, type AgentSessionOption, type Room } from './room-types'
import { shortSessionLabel } from './room-session-pool'
import { readAgentModels, type CatalogModel } from './room-model-catalog'
import { cn } from '@/lib/utils'

/** Room creation lives in a dialog so the sidebar stays a quiet list. */
export function CreateRoomDialog(props: { pool: AgentSessionOption[]; onCreated: () => void }) {
  // Why: this memo boundary needs its own language subscription, while
  // translate() preserves Orca's pseudo-localization behavior.
  useTranslation()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [mode, setMode] = useState<'admin' | 'everyone'>('admin')
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [seedAdminBot, setSeedAdminBot] = useState(true)
  const [adminModel, setAdminModel] = useState('')
  const [adminEffort, setAdminEffort] = useState('')
  const [instructions, setInstructions] = useState('')
  const [adminModels, setAdminModels] = useState<CatalogModel[]>([])
  const worktrees = useAllWorktrees()
  const activeWorktreeId = useActiveWorktreeId()
  useEffect(() => {
    const worktreeId = activeWorktreeId ?? worktrees[0]?.id
    if (!open || !worktreeId) {
      return
    }
    let live = true
    void readAgentModels('codex', worktreeId).then((listed) => {
      if (live) {
        setAdminModels(listed)
      }
    })
    return () => {
      live = false
    }
  }, [open, activeWorktreeId, worktrees])
  const worktreeNames = useMemo(
    () => new Map(worktrees.map((w) => [w.id, w.displayName])),
    [worktrees]
  )

  const toggle = (sessionId: string) => {
    setPicked((cur) =>
      cur.includes(sessionId) ? cur.filter((id) => id !== sessionId) : [...cur, sessionId]
    )
  }

  const submit = async () => {
    if (!name.trim()) {
      toast.error(translate('auto.components.rooms.createRoom.nameRequired', 'Name is required'))
      return
    }
    setBusy(true)
    try {
      const members = picked.map((sessionId, index) => ({
        memberId: `${ORCA_SESSION_PREFIX}${sessionId}`,
        name: shortSessionLabel(
          props.pool.find((p) => p.sessionId === sessionId)?.label || sessionId
        ),
        isAdmin: index === 0
      }))
      const created = await callRuntimeRpc<{ room: Room }>(LOCAL, 'orchestration.roomCreate', {
        name: name.trim(),
        mode,
        members: members.length ? members : undefined
      })
      if (seedAdminBot && created.room && worktrees.length > 0) {
        const worktreeId = activeWorktreeId ?? worktrees[0].id
        try {
          await callRuntimeRpc(LOCAL, 'orchestration.roomBotCreate', {
            id: created.room.id,
            worktree: `id:${worktreeId}`,
            agent: 'codex',
            model: adminModel.trim() || undefined,
            effort: adminEffort || undefined,
            name: 'admin',
            isAdmin: true,
            instructions: instructions.trim() || undefined
          })
        } catch (error) {
          toast.error(
            `${translate('auto.components.rooms.createRoom.adminFailed', 'Room created, but its admin bot failed')}: ${(error as Error).message}`
          )
        }
      }
      toast.success(
        translate('auto.components.rooms.createRoom.created', 'Room "{{name}}" created', {
          name: name.trim()
        })
      )
      setName('')
      setPicked([])
      setInstructions('')
      setAdminModel('')
      setAdminEffort('')
      setOpen(false)
      props.onCreated()
    } catch (error) {
      toast.error(
        `${translate('auto.components.rooms.createRoom.failed', 'Failed to create room')}: ${(error as Error).message}`
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="w-full">
          <Plus className="h-4 w-4" />{' '}
          {translate('auto.components.rooms.createRoom.newRoom', 'New room')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.rooms.createRoom.title', 'New room')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.rooms.createRoom.description',
              'Rooms start with an admin bot so you never talk to an empty room. Your message goes to the admin first; @Name calls one member.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            placeholder={translate('auto.components.rooms.createRoom.namePlaceholder', 'Name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
          <Input
            placeholder={translate(
              'auto.components.rooms.createRoom.briefPlaceholder',
              'Admin brief (optional)'
            )}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            disabled={busy}
          />
          {adminModels.length > 0 ? (
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={adminModel}
              onChange={(e) => {
                setAdminModel(e.target.value)
                setAdminEffort('')
              }}
              disabled={busy}
            >
              <option value="">
                {translate('auto.components.rooms.createRoom.modelDefault', '(agent default)')}
              </option>
              {adminModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          ) : (
            <Input
              placeholder={translate(
                'auto.components.rooms.createRoom.modelPlaceholder',
                'Admin model (optional, e.g. gpt-5.2-codex / opus)'
              )}
              value={adminModel}
              onChange={(e) => setAdminModel(e.target.value)}
              disabled={busy}
            />
          )}
          {(() => {
            const picked = adminModels.find((m) => m.id === adminModel)
            if (!picked || picked.efforts.length === 0) {
              return null
            }
            return (
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={adminEffort}
                onChange={(e) => setAdminEffort(e.target.value)}
                disabled={busy}
              >
                <option value="">
                  {translate('auto.components.rooms.createRoom.effortDefault', '(default thinking)')}
                </option>
                {picked.efforts.map((e) => (
                  <option key={e.value} value={e.value}>
                    {e.label}
                  </option>
                ))}
              </select>
            )
          })()}
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">
              {translate(
                'auto.components.rooms.createRoom.membersLabel',
                'Members (first pick becomes admin):'
              )}
            </div>
            <div className="max-h-40 space-y-0.5 overflow-y-auto scrollbar-sleek">
              {props.pool.length === 0 ? (
                <div className="px-1 py-1 text-xs text-muted-foreground">
                  {translate(
                    'auto.components.rooms.createRoom.noSessions',
                    'No agent sessions open — a fresh admin bot will lead the room.'
                  )}
                </div>
              ) : (
                props.pool.map((opt) => (
                  <button
                    key={opt.sessionId}
                    type="button"
                    onClick={() => toggle(opt.sessionId)}
                    disabled={busy}
                    className={cn(
                      'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors',
                      picked.includes(opt.sessionId)
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:bg-accent/50'
                    )}
                  >
                    <span
                      className={cn(
                        'h-3 w-3 shrink-0 rounded-sm border',
                        picked.includes(opt.sessionId)
                          ? 'border-primary bg-primary'
                          : 'border-muted-foreground/40'
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{shortSessionLabel(opt.label)}</span>
                      <span className="block truncate text-[11px] text-muted-foreground/70">
                        {worktreeNames.get(opt.worktreeId) ?? opt.worktreeId}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <select
              className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm"
              value={mode}
              onChange={(e) => setMode(e.target.value as 'admin' | 'everyone')}
              disabled={busy}
            >
              <option value="admin">
                {translate(
                  'auto.components.rooms.createRoom.modeAdmin',
                  'admin (admin answers first)'
                )}
              </option>
              <option value="everyone">
                {translate(
                  'auto.components.rooms.createRoom.modeEveryone',
                  'everyone (all members speak)'
                )}
              </option>
            </select>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={seedAdminBot}
              onChange={(e) => setSeedAdminBot(e.target.checked)}
              disabled={busy || worktrees.length === 0}
              className="h-3.5 w-3.5"
            />
            <span>
              {translate(
                'auto.components.rooms.createRoom.seedAdmin',
                'Spawn an admin bot (Codex) to lead the room'
              )}
            </span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            {translate('auto.components.rooms.createRoom.cancel', 'Cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {translate('auto.components.rooms.createRoom.create', 'Create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
