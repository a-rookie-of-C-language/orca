/**
 * Room RPC methods: CRUD for group chats and the entry point that sends a user
 * message into a room and runs the opening round of member prompts.
 */

import type { AgentMessageSource } from '../../../../../../shared/agent-session-message-source'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { defineMethod } from '../../../core'
import { runRoomRound, postRoomReply } from '../../../../orchestration/room-round'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import {
  RoomCreateParams,
  RoomDeleteParams,
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

// A room prompt reaches a member as Orca speaking for the group, not as the person
// at the member's own composer.
const ROOM_SOURCE: AgentMessageSource = { kind: 'agent', senders: [], orchestration: null }

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
