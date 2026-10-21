/**
 * Watches turn completions on the structured-agent-session host; when a turn ends on a
 * session that belongs to a room member, the member's latest assistant text is lifted
 * out of the journal and posted into the room through `postRoomReply`, then any
 * `@`-calls it made are run as the next round.
 *
 * Lives as long as the host: the watcher installs itself the first time a room send
 * needs it and never detaches, so a room answers even while no client is looking.
 */

import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { isTextBlock } from '../../../shared/native-chat-types'
import { formatOrcaSessionAddress, isOrcaSessionId } from '../../../shared/orca-session-address'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-host'
import type { AgentSessionTurnCompletionEvent } from '../../../shared/agent-session-turn-completion-wire'
import type { OrchestrationDb } from './db'
import type { RoomMemberRow, RoomWithMembers } from './db/rooms/room-store'
import { postRoomReply, runRoomRound, sendRoomTurn, type RoomRoundDeps } from './room-round'
import {
  parseAdminToolCalls,
  runAdminToolCalls,
  stripToolBlocks,
  type AdminToolRuntime
} from './room-admin-tools'
import { spawnRoomBot } from './room-bot-spawn'
import type { OrcaRuntimeService } from '../orca-runtime'

const WATCHER_ID = 'orchestration-room-replies'
const REPLY_TEXT_MAX = 4000

const watched = new WeakSet<StructuredAgentSessionHost>()
/** Rooms currently running a round; keyed so a reply mid-flight does not double-run. */
const roomsInFlight = new Set<string>()

type WatcherDeps = {
  db: OrchestrationDb
  host: StructuredAgentSessionHost
  /** Without a runtime the watcher still posts replies, but admin tool calls stay inert. */
  runtime?: OrcaRuntimeService
}

function memberForSession(db: OrchestrationDb, sessionId: string): RoomMemberRow[] {
  if (!isOrcaSessionId(sessionId)) return []
  const address = formatOrcaSessionAddress(sessionId)
  return db.db
    .prepare(
      `SELECT room_id, member_id, name, is_admin, seen_seq, session_id, created_at
       FROM room_members WHERE member_id = ? OR session_id = ?`
    )
    .all(address, address) as RoomMemberRow[]
}

function extractAssistantText(items: AgentJournalRenderItem[], turnItemId: string): string {
  const turnItems = items.filter(
    (item) =>
      item.turnScope &&
      item.turnScope.kind === 'turn' &&
      item.turnScope.turnItemId === turnItemId &&
      item.body.kind === 'message' &&
      item.body.role === 'assistant'
  )
  if (!turnItems.length) return ''
  const last = turnItems[turnItems.length - 1]
  if (last.body.kind !== 'message') return ''
  return last.body.blocks
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('\n')
    .trim()
    .slice(0, REPLY_TEXT_MAX)
}

function roundDeps(deps: WatcherDeps, room: RoomWithMembers): RoomRoundDeps {
  return {
    db: deps.db,
    host: deps.host,
    callerKey: `room:${room.id}`,
    expectedRuntimeFenceFor: () => 0,
    fromSource: { kind: 'agent', senders: [], orchestration: null }
  }
}

/** In admin mode, a non-admin reply is routed to the admin so it can respond to the
 *  user's message with what the group just said — the report-back DeepSeek-Bot does
 *  after a round. Skipped when the speaker IS the admin or no admin is set. */
async function reportToAdmin(
  room: RoomWithMembers,
  speaker: RoomMemberRow,
  replyText: string,
  deps: WatcherDeps
): Promise<void> {
  if (room.mode !== 'admin' || !room.admin_member_id) return
  if (speaker.member_id === room.admin_member_id) return
  const admin = room.members.find((m) => m.member_id === room.admin_member_id)
  if (!admin) return
  const prompt = [
    `${speaker.name} just replied in the room "${room.name}":`,
    '',
    replyText,
    '',
    'As this room\'s admin, decide whether the group needs a response. If you have a summary or a follow-up for the user, post it now with no name prefix. Reply [PASS] to stay silent.'
  ].join('\n')
  await sendRoomTurn({
    member: admin,
    host: deps.host,
    callerKey: `room:${room.id}`,
    expectedRuntimeFence: 0,
    prompt,
    fromSource: { kind: 'agent', senders: [], orchestration: null }
  }).catch(() => {
    // A failed report-back must not break the watcher for the rest of the roster.
  })
}

async function handleCompletion(
  completion: Extract<AgentSessionTurnCompletionEvent, { type: 'completion' }>['completion'],
  deps: WatcherDeps
) {
  const memberRows = memberForSession(deps.db, completion.sessionId)
  if (!memberRows.length) return
  const snapshot = await deps.host.journalSnapshot(completion.sessionId)
  const text = extractAssistantText(
    snapshot.items as AgentJournalRenderItem[],
    completion.turnId
  )
  if (!text) return
  for (const memberRow of memberRows) {
    const room = deps.db.getRoom(memberRow.room_id)
    if (!room) continue
    try {
      const toolCalls = memberRow.is_admin === 1 ? parseAdminToolCalls(text) : []
      const postText = toolCalls.length ? stripToolBlocks(text) : text
      const result = postText
        ? await postRoomReply(room, memberRow.member_id, postText, roundDeps(deps, room))
        : { seq: room.seq, followUps: [] }
      await reportToAdmin(room, memberRow, postText || text, deps)
      await runAdminTools(room, memberRow, text, deps)
      if (result.followUps.length && !roomsInFlight.has(room.id)) {
        roomsInFlight.add(room.id)
        try {
          const fresh = deps.db.getRoom(room.id)
          if (fresh) {
            await runRoomRound(
              fresh,
              {
                text: `[Orca: ${result.followUps.map((m) => m.name).join(', ')} called to speak]`,
                who: 'Orca'
              },
              roundDeps(deps, fresh)
            )
          }
        } finally {
          roomsInFlight.delete(room.id)
        }
      }
    } catch {
      // A failed reply must not poison the watcher for other rooms.
    }
  }
}

/** Execute an admin member's group tool calls, show the outcome in the room,
 *  and hand the results back to the admin as its next turn. */
async function runAdminTools(
  room: RoomWithMembers,
  speaker: RoomMemberRow,
  replyText: string,
  deps: WatcherDeps
): Promise<void> {
  if (!deps.runtime || speaker.is_admin !== 1) {
    return
  }
  if (!parseAdminToolCalls(replyText).length) {
    return
  }
  const runtime = deps.runtime
  const toolRt: AdminToolRuntime = {
    db: deps.db,
    caller: speaker,
    defaultWorktree: room.worktree,
    spawnBot: async (args) => {
      const target = deps.db.getRoom(args.roomId)
      if (!target) {
        throw new Error('The room is not here.')
      }
      return spawnRoomBot({
        runtime,
        db: deps.db,
        room: target,
        name: args.name,
        agent: args.agent,
        worktree: args.worktree,
        instructions: args.instructions,
        isAdmin: args.isAdmin
      })
    },
    readLog: (roomId, limit) =>
      (
        deps.db.db
          .prepare(`SELECT who, text FROM room_log WHERE room_id = ? ORDER BY seq DESC LIMIT ?`)
          .all(roomId, limit)
          .toReversed() as { who: string; text: string }[]
      ),
    sendToRoom: async (roomId, text) => {
      const target = deps.db.getRoom(roomId)
      if (!target) {
        throw new Error('The room is not here.')
      }
      await runRoomRound(target, { text, who: 'Orca' }, roundDeps({ db: deps.db, host: deps.host }, target))
    }
  }
  const { results } = await runAdminToolCalls(toolRt, replyText)
  if (!results.length) {
    return
  }
  const summary = results.map((line) => `- ${line}`).join('\n')
  deps.db.appendRoomLine(room.id, { who: 'Orca', text: summary })
  const admin = deps.db.getRoom(room.id)?.members.find((m) => m.member_id === speaker.member_id)
  if (!admin) {
    return
  }
  await sendRoomTurn({
    member: admin,
    host: deps.host,
    callerKey: `room:${room.id}`,
    expectedRuntimeFence: 0,
    prompt: `Your group tools just ran:\n${summary}\n\nTell the user what happened briefly, or reply [PASS] if your room message already says it.`,
    fromSource: { kind: 'agent', senders: [], orchestration: null }
  }).catch(() => {
    // Tool results are already in the room; a missed follow-up is harmless.
  })
}
/** Idempotent. First call per host wires the subscription; later calls no-op. */
export function ensureRoomReplyWatcher(deps: WatcherDeps): void {
  if (watched.has(deps.host)) return
  watched.add(deps.host)
  deps.host.subscribeTurnCompletions({
    id: WATCHER_ID,
    emit: (event) => {
      if (event.type === 'completion') {
        void handleCompletion(event.completion, deps)
      }
    }
  })
}

/** Hook for callers that already hold the runtime; reads the installed host itself. */
export function ensureRoomReplyWatcherForCurrentHost(db: OrchestrationDb, runtime?: OrcaRuntimeService): void {
  const host = getStructuredAgentSessionHost()
  if (host) {
    ensureRoomReplyWatcher({ db, host, runtime })
  }
}
