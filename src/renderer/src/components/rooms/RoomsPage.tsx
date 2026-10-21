/**
 * Group-chat rooms: a list of rooms on the left, a transcript + composer on the right.
 * Members are Orca chat sessions addressed as orca_session_id:<id>; the room mailbox
 * (turn-completion watcher on the host) posts their replies back as they finish.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Bot, Crown, Loader2, Plus, RefreshCw, SendHorizonal, Sparkles, Trash2, UserPlus, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAppStore } from '@/store'
import { useActiveWorktreeId, useAllWorktrees } from '@/store/selectors'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { cn } from '@/lib/utils'

const LOCAL: RuntimeClientTarget = { kind: 'local' }

const ORCA_SESSION_PREFIX = 'orca_session_id:'

type RoomMember = {
  memberId: string
  name: string
  isAdmin: boolean
}

type Room = {
  id: string
  name: string
  mode: 'admin' | 'everyone'
  adminMemberId: string | null
  notice: string
  members: RoomMember[]
}

type RoomLine = {
  seq: number
  who: string
  memberId: string | null
  text: string
  kind: string | null
  createdAt: string
}

const MEMBER_COLORS = [
  'text-sky-400',
  'text-emerald-400',
  'text-amber-400',
  'text-fuchsia-400',
  'text-rose-400',
  'text-cyan-400',
  'text-lime-400',
  'text-orange-400'
]

function memberColor(memberId: string | null): string {
  if (!memberId) return 'text-muted-foreground'
  let hash = 0
  for (const char of memberId) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return MEMBER_COLORS[Math.abs(hash) % MEMBER_COLORS.length]
}

type AgentSessionOption = { sessionId: string; label: string; worktreeId: string }

const BOT_AGENTS = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'aider', label: 'Aider' }
] as const

/** Every mounted agent-session tab across the open workspaces — the pool room
 *  members are picked from (memberId is `orca_session_id:<entityId>`). */
function useAgentSessionPool(): AgentSessionOption[] {
  const tabsByWorktree = useAppStore((s) => s.unifiedTabsByWorktree)
  return useMemo(() => {
    const out: AgentSessionOption[] = []
    for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
      for (const tab of tabs) {
        if (tab.contentType === 'agent-session' && tab.entityId) {
          out.push({ sessionId: tab.entityId, label: tab.label || tab.entityId, worktreeId })
        }
      }
    }
    out.sort((a, b) => b.label.localeCompare(a.label))
    return out
  }, [tabsByWorktree])
}

/** Spawn a new structured agent session into this room — the "create a bot" flow:
 *  the host mints a fresh `orca_session_id:<id>` session at rest, registers it as
 *  a member, and the first room turn is what starts it. */
function SpawnBotForm(props: {
  roomId: string
  onSpawned: () => void
  onCancel: () => void
}) {
  const worktrees = useAllWorktrees()
  const activeWorktreeId = useActiveWorktreeId()
  const [name, setName] = useState('')
  const [agent, setAgent] = useState<string>('claude')
  const [worktreeId, setWorktreeId] = useState<string>(activeWorktreeId ?? '')
  const [instructions, setInstructions] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!worktreeId && worktrees.length > 0) {
      setWorktreeId(worktrees[0].id)
    }
  }, [worktreeId, worktrees])

  const submit = async () => {
    if (!name.trim()) {
      toast.error('Bot needs a name')
      return
    }
    if (!worktreeId) {
      toast.error('Pick a workspace for the bot')
      return
    }
    setBusy(true)
    try {
      await callRuntimeRpc(LOCAL, 'orchestration.roomBotCreate', {
        id: props.roomId,
        worktree: `id:${worktreeId}`,
        agent,
        name: name.trim(),
        instructions: instructions.trim() || undefined
      })
      toast.success(`Bot "${name.trim()}" joined the room`)
      props.onSpawned()
    } catch (error) {
      toast.error(`Failed to spawn bot: ${(error as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-2 rounded-md border border-border/60 bg-card/40 p-3">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Bot className="h-3.5 w-3.5" /> New bot
      </div>
      <Input
        placeholder="Name (e.g. reviewer, planner)"
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
          {worktrees.length === 0 ? <option value="">(no workspace)</option> : null}
          {worktrees.map((w) => (
            <option key={w.id} value={w.id}>
              {w.displayName}
            </option>
          ))}
        </select>
      </div>
      <Input
        placeholder="Role / instructions (optional)"
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        disabled={busy}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={props.onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void submit()} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          Spawn
        </Button>
      </div>
    </div>
  )
}

function useRooms() {
  const [rooms, setRooms] = useState<Room[]>([])
  const [loading, setLoading] = useState(true)
  const refresh = useCallback(async () => {
    try {
      const result = await callRuntimeRpc<{ rooms: Room[] }>(LOCAL, 'orchestration.roomList')
      setRooms(result.rooms)
    } catch (error) {
      toast.error(`Failed to list rooms: ${(error as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])
  return { rooms, loading, refresh }
}

function useRoomLog(roomId: string | null) {
  const [lines, setLines] = useState<RoomLine[]>([])
  const refresh = useCallback(async () => {
    if (!roomId) {
      setLines([])
      return
    }
    try {
      const result = await callRuntimeRpc<{ room: Room; lines: RoomLine[] }>(
        LOCAL,
        'orchestration.roomLog',
        { id: roomId }
      )
      setLines(result.lines)
    } catch (error) {
      toast.error(`Failed to read room log: ${(error as Error).message}`)
    }
  }, [roomId])
  useEffect(() => {
    void refresh()
    if (!roomId) return
    const timer = setInterval(() => void refresh(), 3000)
    return () => clearInterval(timer)
  }, [refresh, roomId])
  return { lines, refresh }
}

function CreateRoomForm(props: { onCreated: () => void; pool: AgentSessionOption[] }) {
  const [name, setName] = useState('')
  const [mode, setMode] = useState<'admin' | 'everyone'>('everyone')
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [seedAdminBot, setSeedAdminBot] = useState(true)
  const worktrees = useAllWorktrees()
  const activeWorktreeId = useActiveWorktreeId()

  const toggle = (sessionId: string) =>
    setPicked((cur) => (cur.includes(sessionId) ? cur.filter((id) => id !== sessionId) : [...cur, sessionId]))

  const submit = async () => {
    if (!name.trim()) {
      toast.error('Name is required')
      return
    }
    setBusy(true)
    try {
      const members = picked.map((sessionId, index) => ({
        memberId: `${ORCA_SESSION_PREFIX}${sessionId}`,
        name: props.pool.find((p) => p.sessionId === sessionId)?.label || sessionId,
        isAdmin: index === 0 // first pick leads the room
      }))
      const created = await callRuntimeRpc<{ room: Room }>(LOCAL, 'orchestration.roomCreate', {
        name: name.trim(),
        mode,
        members: members.length ? members : undefined
      })
      // DeepSeek-Bot's flow: a brand-new room starts with an admin bot already
      // seated so "create group, then talk" never means "talk to an empty room".
      if (seedAdminBot && created.room && worktrees.length > 0) {
        const worktreeId = activeWorktreeId ?? worktrees[0].id
        try {
          await callRuntimeRpc(LOCAL, 'orchestration.roomBotCreate', {
            id: created.room.id,
            worktree: `id:${worktreeId}`,
            agent: 'claude',
            name: 'admin',
            isAdmin: true,
            instructions:
              'You are the admin of this group chat. When the user speaks, answer them or call the right member with @Name. Keep answers short; use your tools when asked to do work.'
          })
        } catch (error) {
          toast.error(`Room created, but its admin bot failed: ${(error as Error).message}`)
        }
      }
      toast.success(`Room "${name.trim()}" created`)
      setName('')
      setPicked([])
      props.onCreated()
    } catch (error) {
      toast.error(`Failed to create room: ${(error as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-2 rounded-md border border-border/60 bg-card/40 p-3">
      <div className="text-sm font-medium">New room</div>
      <Input
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={busy}
      />
      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">
          Members (first pick becomes admin):
        </div>
        <div className="max-h-32 space-y-0.5 overflow-y-auto">
          {props.pool.length === 0 ? (
            <div className="px-1 py-1 text-xs text-muted-foreground/70">
              No agent sessions open — start one in a workspace first.
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
                    ? 'bg-primary/20 text-primary'
                    : 'hover:bg-accent/50 text-muted-foreground'
                )}
              >
                <span
                  className={cn(
                    'h-3 w-3 rounded-sm border',
                    picked.includes(opt.sessionId) ? 'border-primary bg-primary' : 'border-muted-foreground/40'
                  )}
                />
                <span className="truncate">{opt.label}</span>
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
          <option value="everyone">everyone (all members speak)</option>
          <option value="admin">admin (admin answers first)</option>
        </select>
        <Button size="sm" onClick={() => void submit()} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Create
        </Button>
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={seedAdminBot}
          onChange={(e) => setSeedAdminBot(e.target.checked)}
          disabled={busy || worktrees.length === 0}
          className="h-3.5 w-3.5"
        />
        <span>Spawn an admin bot (Claude) to lead the room</span>
      </label>
    </div>
  )
}

export default function RoomsPage(): JSX.Element {
  const { rooms, loading, refresh } = useRooms()
  const pool = useAgentSessionPool()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [composer, setComposer] = useState('')
  const [sending, setSending] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [spawnOpen, setSpawnOpen] = useState(false)
  const closeRoomsPage = useAppStore((s) => s.closeRoomsPage)
  const selected = useMemo(
    () => rooms.find((room) => room.id === selectedId) ?? rooms[0] ?? null,
    [rooms, selectedId]
  )
  const { lines, refresh: refreshLog } = useRoomLog(selected?.id ?? null)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [lines.length])

  const send = async () => {
    if (!selected || !composer.trim() || sending) return
    setSending(true)
    try {
      await callRuntimeRpc(LOCAL, 'orchestration.roomSend', {
        id: selected.id,
        text: composer.trim()
      })
      setComposer('')
      await refreshLog()
    } catch (error) {
      toast.error(`Failed to send: ${(error as Error).message}`)
    } finally {
      setSending(false)
    }
  }

  const deleteRoom = async () => {
    if (!selected) return
    try {
      await callRuntimeRpc(LOCAL, 'orchestration.roomDelete', { id: selected.id })
      toast.success(`Room deleted`)
      setSelectedId(null)
      await refresh()
    } catch (error) {
      toast.error(`Failed to delete: ${(error as Error).message}`)
    }
  }

  const addMember = async (sessionId: string, isAdmin: boolean) => {
    if (!selected) return
    const opt = pool.find((p) => p.sessionId === sessionId)
    try {
      await callRuntimeRpc(LOCAL, 'orchestration.roomMemberAdd', {
        id: selected.id,
        memberId: `${ORCA_SESSION_PREFIX}${sessionId}`,
        name: opt?.label || sessionId,
        isAdmin
      })
      await refresh()
      setAddOpen(false)
      toast.success('Member added')
    } catch (error) {
      toast.error(`Failed to add member: ${(error as Error).message}`)
    }
  }

  const removeMember = async (memberId: string) => {
    if (!selected) return
    try {
      await callRuntimeRpc(LOCAL, 'orchestration.roomMemberRemove', {
        id: selected.id,
        memberId
      })
      await refresh()
    } catch (error) {
      toast.error(`Failed to remove member: ${(error as Error).message}`)
    }
  }

  const poolAvailable = useMemo(
    () => pool.filter((p) => !selected?.members.some((m) => m.memberId === `${ORCA_SESSION_PREFIX}${p.sessionId}`)),
    [pool, selected]
  )

  return (
    <div className="flex h-full min-h-0 bg-background text-foreground">
      <aside className="flex w-72 flex-col border-r border-border/60 bg-card/20">
        <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
          <div className="text-sm font-semibold">Rooms</div>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void refresh()}
              title="Refresh rooms"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={closeRoomsPage}>
              Close
            </Button>
          </div>
        </div>
        <ScrollArea className="flex-1">
          <div className="space-y-1 p-2">
            {loading ? (
              <div className="flex items-center gap-2 px-2 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : rooms.length === 0 ? (
              <div className="px-2 py-4 text-sm text-muted-foreground">No rooms yet.</div>
            ) : (
              rooms.map((room) => (
                <button
                  key={room.id}
                  type="button"
                  onClick={() => setSelectedId(room.id)}
                  className={cn(
                    'w-full rounded-md px-3 py-2 text-left text-sm hover:bg-accent/50',
                    selected?.id === room.id && 'bg-accent text-accent-foreground'
                  )}
                >
                  <div className="font-medium">{room.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {room.mode} · {room.members.length} member
                    {room.members.length === 1 ? '' : 's'}
                  </div>
                </button>
              ))
            )}
          </div>
        </ScrollArea>
        <div className="border-t border-border/60 p-2">
          <CreateRoomForm
            pool={pool}
            onCreated={() => {
              void refresh()
            }}
          />
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <>
            <header className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-2">
              <div>
                <div className="font-semibold">{selected.name}</div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setSpawnOpen((v) => !v)
                    setAddOpen(false)
                  }}
                  title="Spawn a bot into this room"
                >
                  <Bot className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setAddOpen((v) => !v)
                    setSpawnOpen(false)
                  }}
                  title="Add member"
                >
                  <UserPlus className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => void deleteRoom()}
                  title="Delete room"
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </header>
            <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-4 py-2">
              {selected.members.length === 0 ? (
                <span className="text-xs text-muted-foreground">No members — add one below.</span>
              ) : (
                selected.members.map((m) => (
                  <span
                    key={m.memberId}
                    className={cn(
                      'group inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
                      m.isAdmin ? 'border-amber-400/60 bg-amber-400/10' : 'border-border/60'
                    )}
                  >
                    <Bot className="h-3 w-3 text-muted-foreground" />
                    {m.isAdmin ? <Crown className="h-3 w-3 text-amber-400" /> : null}
                    {m.name}
                    <button
                      type="button"
                      onClick={() => void removeMember(m.memberId)}
                      className="ml-0.5 hidden rounded-full p-0.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive group-hover:inline-flex"
                      title="Remove member"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))
              )}
            </div>
            {spawnOpen ? (
              <div className="border-b border-border/60 px-4 py-2">
                <SpawnBotForm
                  roomId={selected.id}
                  onSpawned={() => {
                    setSpawnOpen(false)
                    void refresh()
                  }}
                  onCancel={() => setSpawnOpen(false)}
                />
              </div>
            ) : null}
            {addOpen ? (
              <div className="space-y-1.5 border-b border-border/60 px-4 py-2">
                <div className="text-xs font-medium text-muted-foreground">Add member</div>
                <div className="max-h-28 space-y-0.5 overflow-y-auto">
                  {poolAvailable.length === 0 ? (
                    <div className="text-xs text-muted-foreground/70">
                      All open agent sessions are already in this room.
                    </div>
                  ) : (
                    poolAvailable.map((opt) => (
                      <div key={opt.sessionId} className="flex items-center justify-between gap-2 rounded px-2 py-1 hover:bg-accent/40">
                        <span className="truncate text-xs">{opt.label}</span>
                        <div className="flex gap-1">
                          <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => void addMember(opt.sessionId, false)}>
                            Add
                          </Button>
                          <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => void addMember(opt.sessionId, true)}>
                            Add as admin
                          </Button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : null}
            <ScrollArea className="flex-1">
              <div className="space-y-3 p-4">
                {lines.length === 0 ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">
                    No messages yet. Say hi, or @-call a member.
                  </div>
                ) : (
                  lines.map((line) => (
                    <div key={line.seq} className="text-sm">
                      <div className={cn('mb-0.5 text-xs font-medium', memberColor(line.memberId))}>
                        {line.who}
                        {line.kind ? (
                          <span className="ml-2 text-muted-foreground/70">[{line.kind}]</span>
                        ) : null}
                      </div>
                      <div className="whitespace-pre-wrap break-words">{line.text}</div>
                    </div>
                  ))
                )}
                <div ref={bottomRef} />
              </div>
            </ScrollArea>
            <footer className="border-t border-border/60 p-3">
              <div className="flex gap-2">
                <Input
                  placeholder="Message… @Name to call one, @all (admin only) for everyone"
                  value={composer}
                  onChange={(e) => setComposer(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      void send()
                    }
                  }}
                  disabled={sending}
                />
                <Button onClick={() => void send()} disabled={sending || !composer.trim()}>
                  {sending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <SendHorizonal className="h-4 w-4" />
                  )}
                  Send
                </Button>
              </div>
            </footer>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Pick a room, or create one on the left.
          </div>
        )}
      </main>
    </div>
  )
}
