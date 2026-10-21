/**
 * Room RPC methods: CRUD for group chats and the entry point that sends a user
 * message into a room and runs the opening round of member prompts.
 */

import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { defineMethod } from '../../../core'
import { runRoomRound, postRoomReply } from '../../../../orchestration/room-round'
import { ROOM_SOURCE, spawnRoomBot } from '../../../../orchestration/room-bot-spawn'
import { MAIN_BOT_NAME, MAIN_BOT_ROOM_NAME } from '../../../../orchestration/room-admin-tools'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { ensureRoomReplyWatcherForCurrentHost } from '../../../../orchestration/room-reply-watcher'
import {
  RoomBotCreateParams,
  RoomCreateParams,
  RoomDeleteParams,
  RoomEnsureMainBotParams,
  RoomListParams,
  RoomLogParams,
  RoomMemberAddParams,
  RoomMemberRemoveParams,
  RoomPostParams,
  RoomSendParams,
  RoomShowParams
} from '../../../../../../shared/rpc-contract/orchestration-rooms-params'

const roomError = (code: string, message: string) => new OrchestrationError(code, message)

const exposeRoom = (room: {
  id: string
  name: string
  mode: string
  admin_member_id: string | null
  notice: string
  worktree: string
  seq: number
  created_at: string
  updated_at: string
  members: {
    member_id: string
    name: string
    is_admin: number
    seen_seq: number
    session_id: string | null
  }[]
}) => ({
  id: room.id,
  name: room.name,
  mode: room.mode,
  adminMemberId: room.admin_member_id,
  notice: room.notice,
  worktree: room.worktree,
  seq: room.seq,
  createdAt: room.created_at,
  updatedAt: room.updated_at,
  members: room.members.map((m) => ({
    memberId: m.member_id,
    name: m.name,
    isAdmin: m.is_admin === 1,
    seenSeq: m.seen_seq,
    sessionId: m.session_id
  }))
})

const exposeRoomLine = (line: {
  seq: number
  who: string
  member_id: string | null
  text: string
  kind: string | null
  created_at: string
}) => ({
  seq: line.seq,
  who: line.who,
  memberId: line.member_id,
  text: line.text,
  kind: line.kind,
  createdAt: line.created_at
})

export const ORCHESTRATION_ROOM_METHODS = [
  defineMethod({
    name: 'orchestration.roomCreate',
    permission: 'workspace',
    params: RoomCreateParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const room = db.createRoom({
        name: params.name,
        mode: params.mode,
        notice: params.notice,
        worktree: params.worktree,
        members: params.members
      })
      return { room: exposeRoom(room) }
    }
  }),

  defineMethod({
    name: 'orchestration.roomList',
    permission: 'workspace',
    params: RoomListParams,
    handler: (_params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      return { rooms: db.listRooms().map(exposeRoom) }
    }
  }),

  defineMethod({
    name: 'orchestration.roomShow',
    permission: 'workspace',
    params: RoomShowParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const room = params.id
        ? db.getRoom(params.id)
        : params.name
          ? db.getRoomByName(params.name)
          : undefined
      if (!room) throw roomError('room_not_found', 'The room is not here.')
      return { room: exposeRoom(room) }
    }
  }),

  defineMethod({
    name: 'orchestration.roomDelete',
    permission: 'workspace',
    params: RoomDeleteParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      db.deleteRoom(params.id)
      return { ok: true }
    }
  }),

  defineMethod({
    name: 'orchestration.roomMemberAdd',
    permission: 'workspace',
    params: RoomMemberAddParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      db.addRoomMember(params.id, {
        memberId: params.memberId,
        name: params.name,
        isAdmin: params.isAdmin
      })
      const room = db.getRoom(params.id)
      if (!room) throw roomError('room_not_found', 'The room is not here.')
      return { room: exposeRoom(room) }
    }
  }),

  defineMethod({
    name: 'orchestration.roomBotCreate',
    permission: 'workspace',
    params: RoomBotCreateParams,
    handler: async (params, ctx) => {
      const db = ctx.runtime.getOrchestrationDb()
      const room = db.getRoom(params.id)
      if (!room) throw roomError('room_not_found', 'The room is not here.')
      const spawned = await spawnRoomBot({
        runtime: ctx.runtime,
        db,
        room,
        name: params.name,
        agent: params.agent,
        worktree: params.worktree,
        instructions: params.instructions,
        isAdmin: params.isAdmin
      })
      ensureRoomReplyWatcherForCurrentHost(db, ctx.runtime)
      const fresh = db.getRoom(room.id)
      return { memberId: spawned.memberId, sessionId: spawned.sessionId, room: fresh ? exposeRoom(fresh) : null }
    }
  }),

  defineMethod({
    name: 'orchestration.roomEnsureMainBot',
    permission: 'workspace',
    params: RoomEnsureMainBotParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const roomName = params.roomName?.trim() || MAIN_BOT_ROOM_NAME
      const botName = params.botName?.trim() || MAIN_BOT_NAME
      const agent = params.agent?.trim() || 'claude'
      let room = db.getRoomByName(roomName)
      if (!room) {
        room = db.createRoom({
          name: roomName,
          mode: 'admin',
          notice: 'Orca HQ: talk to the admin to manage bots and group chats.',
          worktree: params.worktree
        })
      } else if (!room.worktree && params.worktree) {
        db.setRoomWorktree(room.id, params.worktree)
      }
      const admin = room.members.find((m) => m.is_admin === 1)
      if (!admin) {
        await spawnRoomBot({
          runtime,
          db,
          room,
          name: botName,
          agent,
          worktree: room.worktree || params.worktree,
          isAdmin: true
        })
      }
      ensureRoomReplyWatcherForCurrentHost(db, runtime)
      const fresh = db.getRoom(room.id)
      if (!fresh) {
        throw roomError('room_not_found', 'The room is not here.')
      }
      return { room: exposeRoom(fresh) }
    }
  }),

  defineMethod({
    name: 'orchestration.roomMemberRemove',
    permission: 'workspace',
    params: RoomMemberRemoveParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      db.removeRoomMember(params.id, params.memberId)
      return { ok: true }
    }
  }),

  defineMethod({
    name: 'orchestration.roomSend',
    permission: 'workspace',
    params: RoomSendParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const room = params.id
        ? db.getRoom(params.id)
        : params.name
          ? db.getRoomByName(params.name)
          : undefined
      if (!room) throw roomError('room_not_found', 'The room is not here.')
      const host = getStructuredAgentSessionHost()
      if (!host) {
        throw roomError(
          'room_no_chat_host',
          'The agent-session host is not installed in this runtime.'
        )
      }
      const result = await runRoomRound(
        room,
        { text: params.text, who: params.from ?? 'User' },
        {
          db,
          host,
          callerKey: `room:${room.id}`,
          expectedRuntimeFenceFor: () => 0,
          fromSource: ROOM_SOURCE
        }
      )
      ensureRoomReplyWatcherForCurrentHost(db, runtime)
      return {
        seq: result.seq,
        slots: result.slots.map((s) => ({
          memberId: s.memberId,
          name: s.name,
          status: s.status,
          note: s.note
        }))
      }
    }
  }),

  defineMethod({
    name: 'orchestration.roomPost',
    permission: 'workspace',
    params: RoomPostParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const room = db.getRoom(params.id)
      if (!room) throw roomError('room_not_found', 'The room is not here.')
      const host = getStructuredAgentSessionHost()
      if (!host) {
        throw roomError(
          'room_no_chat_host',
          'The agent-session host is not installed in this runtime.'
        )
      }
      const result = await postRoomReply(room, params.memberId, params.text, {
        db,
        host,
        callerKey: `room:${room.id}`,
        expectedRuntimeFenceFor: () => 0,
          fromSource: ROOM_SOURCE
      })
      ensureRoomReplyWatcherForCurrentHost(db, runtime)
      return {
        seq: result.seq,
        followUps: result.followUps.map((m) => ({
          memberId: m.member_id,
          name: m.name
        }))
      }
    }
  }),

  defineMethod({
    name: 'orchestration.roomLog',
    permission: 'workspace',
    params: RoomLogParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const room = db.getRoom(params.id)
      if (!room) throw roomError('room_not_found', 'The room is not here.')
      const limit = params.limit ?? 60
      const lines = params.memberId
        ? db.unseenRoomLines(room.id, params.memberId, 200, limit)
        : (db
            .db
            .prepare(`SELECT * FROM room_log WHERE room_id = ? ORDER BY seq DESC LIMIT ?`)
            .all(room.id, limit)
            .reverse() as {
            seq: number
            who: string
            member_id: string | null
            text: string
            kind: string | null
            created_at: string
          }[])
      return { room: exposeRoom(room), lines: lines.map(exposeRoomLine) }
    }
  })
]
