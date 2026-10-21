import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionTurnCompletionEvent } from '../../../shared/agent-session-turn-completion-wire'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-host'
import { OrchestrationDb } from './db'
import { ensureRoomReplyWatcher } from './room-reply-watcher'

const aliceMember = 'orca_session_id:session_alice_0001'
const betaMember = 'orca_session_id:session_beta_0002'

type Subscriber = { emit: (event: AgentSessionTurnCompletionEvent) => void }

const hostWith = (snapshotItems: unknown[] = []) => {
  const subscribers: Subscriber[] = []
  const host = {
    subscribeTurnCompletions: vi.fn((sub: Subscriber) => {
      subscribers.push(sub)
      return () => undefined
    }),
    journalSnapshot: vi.fn(async () => ({ items: snapshotItems }))
  }
  return { host: host as unknown as StructuredAgentSessionHost, subscribers }
}

const completionFor = (sessionId: string, turnId: string): AgentSessionTurnCompletionEvent => ({
  type: 'completion',
  completion: {
    scope: { kind: 'local', hostId: 'h', workspaceId: 'w' } as never,
    sessionId,
    turnId,
    outcome: { kind: 'success' } as never,
    completedAt: Date.now()
  }
})

const assistantItem = (turnItemId: string, text: string) => ({
  itemId: `item-${turnItemId}`,
  revision: 0,
  sequence: 1,
  observedAt: 1,
  turnScope: { kind: 'turn' as const, turnItemId },
  body: {
    kind: 'message' as const,
    role: 'assistant' as const,
    blocks: [{ type: 'text' as const, text }]
  }
})

const seedRoom = (db: OrchestrationDb) =>
  db.createRoom({
    name: 'demo',
    mode: 'everyone',
    members: [
      { memberId: aliceMember, name: 'alice', isAdmin: true },
      { memberId: betaMember, name: 'beta' }
    ]
  })

describe('room-reply-watcher', () => {
  it('posts the member reply into the room when its turn completes', async () => {
    const db = new OrchestrationDb(':memory:')
    const room = seedRoom(db)
    const { host, subscribers } = hostWith([assistantItem('turn-1', 'hello room')])
    ensureRoomReplyWatcher({ db, host })

    subscribers[0].emit(completionFor('session_alice_0001', 'turn-1'))
    await vi.waitFor(() => {
      const row = db.db
        .prepare(`SELECT who, text FROM room_log WHERE room_id = ? ORDER BY seq DESC LIMIT 1`)
        .get(room.id) as { who: string; text: string } | undefined
      expect(row?.who).toBe('alice')
      expect(row?.text).toBe('hello room')
    })
  })

  it('ignores completions on sessions that belong to no member', async () => {
    const db = new OrchestrationDb(':memory:')
    const room = seedRoom(db)
    const { host, subscribers } = hostWith([assistantItem('turn-1', 'noise')])
    ensureRoomReplyWatcher({ db, host })

    subscribers[0].emit(completionFor('session_stranger', 'turn-1'))
    await new Promise((r) => setTimeout(r, 30))
    const count = db.db
      .prepare(`SELECT COUNT(*) AS n FROM room_log WHERE room_id = ?`)
      .get(room.id) as { n: number }
    expect(count.n).toBe(0)
  })

  it('subscribes the host only once', () => {
    const db = new OrchestrationDb(':memory:')
    const { host } = hostWith()
    ensureRoomReplyWatcher({ db, host })
    ensureRoomReplyWatcher({ db, host })
    expect(host.subscribeTurnCompletions).toHaveBeenCalledTimes(1)
  })
})
