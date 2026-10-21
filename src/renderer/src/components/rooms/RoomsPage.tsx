/**
 * Group-chat rooms: a list of rooms on the left, a transcript + composer on the right.
 * Members are Orca chat sessions addressed as orca_session_id:<id>; the room mailbox
 * (turn-completion watcher on the host) posts their replies back as they finish.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Loader2, Plus, RefreshCw, SendHorizonal, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { cn } from '@/lib/utils'

const LOCAL: RuntimeClientTarget = { kind: 'local' }

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

function CreateRoomForm(props: { onCreated: () => void }) {
  const [name, setName] = useState('')
  const [members, setMembers] = useState('')
  const [mode, setMode] = useState<'admin' | 'everyone'>('everyone')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!name.trim()) {
      toast.error('Name is required')
      return
    }
    setBusy(true)
    try {
      const parsed = members
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          const [memberId, alias, flag] = entry.split(':')
          return { memberId, name: alias || memberId, isAdmin: flag === 'admin' }
        })
      await callRuntimeRpc(LOCAL, 'orchestration.roomCreate', {
        name: name.trim(),
        mode,
        members: parsed.length ? parsed : undefined
      })
      toast.success(`Room "${name.trim()}" created`)
      setName('')
      setMembers('')
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
      <Input
        placeholder="members: orca_session_id:xxx:alice:admin, orca_session_id:yyy:bob"
        value={members}
        onChange={(e) => setMembers(e.target.value)}
        disabled={busy}
      />
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
    </div>
  )
}

export default function RoomsPage(): JSX.Element {
  const { rooms, loading, refresh } = useRooms()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [composer, setComposer] = useState('')
  const [sending, setSending] = useState(false)
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
            onCreated={() => {
              void refresh()
            }}
          />
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <>
            <header className="flex items-center justify-between border-b border-border/60 px-4 py-2">
              <div>
                <div className="font-semibold">{selected.name}</div>
                <div className="text-xs text-muted-foreground">
                  {selected.members.map((m) => m.name).join(', ') || '(no members)'}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void deleteRoom()}
                title="Delete room"
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </header>
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
