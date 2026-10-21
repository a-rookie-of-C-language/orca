/**
 * Group-chat rooms list + transcript + composer.
 * Members are Orca chat sessions addressed as orca_session_id:<id>.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'
import { useAllWorktrees } from '@/store/selectors'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { LOCAL, ORCA_SESSION_PREFIX } from './room-types'
import { shortSessionLabel, useAgentSessionPool } from './room-session-pool'
import { useRooms } from './useRooms'
import { useRoomLog } from './useRoomLog'
import { RoomSidebar } from './RoomSidebar'
import { RoomChatHeader } from './RoomChatHeader'
import { RoomRosterBar } from './RoomRosterBar'
import { RoomTranscript } from './RoomTranscript'
import { RoomComposer } from './RoomComposer'

export default function RoomsPage(): JSX.Element {
  // Why: this memo boundary needs its own language subscription, while
  // translate() preserves Orca's pseudo-localization behavior.
  useTranslation()
  const { rooms, loading, refresh } = useRooms()
  const pool = useAgentSessionPool()
  const worktrees = useAllWorktrees()
  const worktreeNames = useMemo(
    () => new Map(worktrees.map((w) => [w.id, w.displayName])),
    [worktrees]
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [composer, setComposer] = useState('')
  const [sending, setSending] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [spawnOpen, setSpawnOpen] = useState(false)
  const [lastSlots, setLastSlots] = useState<{ name: string; status: string }[]>([])
  const selected = useMemo(
    () => rooms.find((room) => room.id === selectedId) ?? rooms[0] ?? null,
    [rooms, selectedId]
  )
  const { lines, refresh: refreshLog } = useRoomLog(selected?.id ?? null)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [lines.length])

  const mentionQuery = useMemo(() => {
    const m = composer.match(/@([\w\u4e00-\u9fa5]*)$/)
    return m ? m[1].toLowerCase() : null
  }, [composer])
  const mentionOptions = useMemo(() => {
    if (mentionQuery === null || !selected) {
      return []
    }
    const names = selected.members.map((mem) => mem.name)
    if (selected.adminMemberId) {
      names.push('all')
    }
    return names.filter((n) => n.toLowerCase().includes(mentionQuery)).slice(0, 8)
  }, [mentionQuery, selected])
  const applyMention = useCallback((name: string) => {
    setComposer((cur) => cur.replace(/@([\w\u4e00-\u9fa5]*)$/, `@${name} `))
  }, [])

  const sendText = useCallback(
    async (text: string) => {
      if (!selected || !text.trim() || sending) {
        return
      }
      setSending(true)
      try {
        const result = await callRuntimeRpc<{
          seq: number
          slots: { name: string; status: string }[]
        }>(LOCAL, 'orchestration.roomSend', { id: selected.id, text: text.trim() })
        setComposer('')
        setLastSlots(result.slots ?? [])
        await refreshLog()
      } catch (error) {
        toast.error(
          `${translate('auto.components.rooms.page.sendFailed', 'Failed to send')}: ${(error as Error).message}`
        )
      } finally {
        setSending(false)
      }
    },
    [selected, sending, refreshLog]
  )

  const deleteRoom = async () => {
    if (!selected) {
      return
    }
    try {
      await callRuntimeRpc(LOCAL, 'orchestration.roomDelete', { id: selected.id })
      toast.success(translate('auto.components.rooms.page.deleted', 'Room deleted'))
      setSelectedId(null)
      await refresh()
    } catch (error) {
      toast.error(
        `${translate('auto.components.rooms.page.deleteFailed', 'Failed to delete')}: ${(error as Error).message}`
      )
    }
  }

  const addMember = async (sessionId: string, isAdmin: boolean) => {
    if (!selected) {
      return
    }
    const opt = pool.find((p) => p.sessionId === sessionId)
    try {
      await callRuntimeRpc(LOCAL, 'orchestration.roomMemberAdd', {
        id: selected.id,
        memberId: `${ORCA_SESSION_PREFIX}${sessionId}`,
        name: shortSessionLabel(opt?.label || sessionId),
        isAdmin
      })
      await refresh()
      setAddOpen(false)
      toast.success(translate('auto.components.rooms.page.memberAdded', 'Member added'))
    } catch (error) {
      toast.error(
        `${translate('auto.components.rooms.page.addMemberFailed', 'Failed to add member')}: ${(error as Error).message}`
      )
    }
  }

  const removeMember = async (memberId: string) => {
    if (!selected) {
      return
    }
    try {
      await callRuntimeRpc(LOCAL, 'orchestration.roomMemberRemove', { id: selected.id, memberId })
      await refresh()
    } catch (error) {
      toast.error(
        `${translate('auto.components.rooms.page.removeMemberFailed', 'Failed to remove member')}: ${(error as Error).message}`
      )
    }
  }

  const poolAvailable = useMemo(
    () =>
      pool.filter(
        (p) => !selected?.members.some((m) => m.memberId === `${ORCA_SESSION_PREFIX}${p.sessionId}`)
      ),
    [pool, selected]
  )
  const adminName = selected?.members.find((m) => m.isAdmin)?.name ?? null

  return (
    <div className="flex h-full min-h-0 bg-background text-foreground">
      <RoomSidebar
        rooms={rooms}
        loading={loading}
        selectedId={selected?.id ?? null}
        pool={pool}
        onSelect={setSelectedId}
        onRefresh={() => void refresh()}
        onCreated={() => void refresh()}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <>
            <RoomChatHeader
              selected={selected}
              adminName={adminName}
              onToggleSpawn={() => {
                setSpawnOpen((v) => !v)
                setAddOpen(false)
              }}
              onToggleAdd={() => {
                setAddOpen((v) => !v)
                setSpawnOpen(false)
              }}
              onDelete={() => void deleteRoom()}
            />
            <RoomRosterBar
              selected={selected}
              spawnOpen={spawnOpen}
              addOpen={addOpen}
              poolAvailable={poolAvailable}
              worktreeNames={worktreeNames}
              onSpawned={() => {
                setSpawnOpen(false)
                void refresh()
              }}
              onCancelSpawn={() => setSpawnOpen(false)}
              onAddMember={(sessionId, isAdmin) => void addMember(sessionId, isAdmin)}
              onRemoveMember={(memberId) => void removeMember(memberId)}
            />
            <RoomTranscript
              selected={selected}
              lines={lines}
              adminName={adminName}
              bottomRef={bottomRef}
              onQuickSend={(t) => void sendText(t)}
              onSpawnBot={() => {
                setSpawnOpen(true)
                setAddOpen(false)
              }}
            />
            <RoomComposer
              composer={composer}
              sending={sending}
              lastSlots={lastSlots}
              mentionOptions={mentionOptions}
              mentionQuery={mentionQuery}
              onComposerChange={setComposer}
              onApplyMention={applyMention}
              onSend={() => void sendText(composer)}
            />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {translate(
              'auto.components.rooms.page.pickRoom',
              'Pick a room, or create one on the left.'
            )}
          </div>
        )}
      </main>
    </div>
  )
}
