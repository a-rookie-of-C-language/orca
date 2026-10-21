/**
 * Room store: rooms, members, and the room transcript.
 *
 * A room is a group chat between the user and a set of agents. Agents keep their own
 * session per room (`session_id` on `room_members`), and share the room's ordered
 * `room_log`. `seen_seq` is each member's read cursor; unseen lines are what the
 * round runner hands to that member next turn.
 */

import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'

export type RoomMode = 'admin' | 'everyone'

export type RoomRow = {
  id: string
  name: string
  mode: RoomMode
  admin_member_id: string | null
  notice: string
  worktree: string
  seq: number
  created_at: string
  updated_at: string
}

export type RoomMemberRow = {
  room_id: string
  member_id: string
  name: string
  is_admin: number
  seen_seq: number
  session_id: string | null
  created_at: string
}

export type RoomLogKind =
  | 'lookup'
  | 'resumed'
  | 'cut'
  | 'stopped'
  | 'done'
  | 'failed'
  | 'missed'
  | 'approval'

export type RoomLogRow = {
  room_id: string
  seq: number
  who: string
  member_id: string | null
  text: string
  kind: RoomLogKind | null
  payload: string | null
  created_at: string
}

export type RoomWithMembers = RoomRow & { members: RoomMemberRow[] }

const ROOM_MAX_MEMBERS = 12
const ROOM_NAME_MAX = 60
const ROOM_NOTICE_MAX = 2000
const ROOM_LOG_MAX = 60

const invalid = (message: string) => Object.assign(new Error(message), { code: 'room/invalid' })

export function createRoom(
  this: OrchestrationDb,
  input: {
    name: string
    mode?: RoomMode
    notice?: string
    worktree?: string
    members?: { memberId: string; name: string; isAdmin?: boolean }[]
  }
): RoomWithMembers {
  const name = String(input.name ?? '').trim()
  if (!name) throw invalid('A room needs a name')
  if (name.length > ROOM_NAME_MAX) throw invalid(`Room name is over ${ROOM_NAME_MAX} characters`)
  const notice = String(input.notice ?? '').slice(0, ROOM_NOTICE_MAX)
  const worktree = String(input.worktree ?? '')
  const mode: RoomMode = input.mode === 'everyone' ? 'everyone' : 'admin'
  const members = input.members ?? []
  if (members.length > ROOM_MAX_MEMBERS)
    throw invalid(`A room has at most ${ROOM_MAX_MEMBERS} members`)

  const id = generateId('room')
  const now = new Date().toISOString()
  const insertRoom = this.db.prepare(
    `INSERT INTO rooms (id, name, mode, admin_member_id, notice, worktree, seq, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, 0, ?, ?)`
  )
  const insertMember = this.db.prepare(
    `INSERT INTO room_members (room_id, member_id, name, is_admin, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
  const setAdmin = this.db.prepare(
    `UPDATE rooms SET admin_member_id = ?, updated_at = ? WHERE id = ?`
  )
  const namesSeen = new Set<string>()
  let adminMemberId: string | null = null

  this.db.exec('BEGIN IMMEDIATE')
  try {
    insertRoom.run(id, name, mode, notice, worktree, now, now)
    for (const member of members) {
      const memberName = String(member.name ?? '').trim()
      if (!memberName) throw invalid('A member needs a name')
      const key = memberName.toLowerCase()
      if (namesSeen.has(key)) throw invalid(`Duplicate member name "${memberName}"`)
      namesSeen.add(key)
      const isAdmin = member.isAdmin ? 1 : 0
      insertMember.run(id, member.memberId, memberName, isAdmin, now)
      if (isAdmin && adminMemberId === null) adminMemberId = member.memberId
    }
    if (adminMemberId) setAdmin.run(adminMemberId, now, id)
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
  return this.getRoom(id)!
}

export function getRoom(this: OrchestrationDb, roomId: string): RoomWithMembers | undefined {
  const room = this.db.prepare(`SELECT * FROM rooms WHERE id = ?`).get(roomId) as
    | RoomRow
    | undefined
  if (!room) return undefined
  const members = this.db
    .prepare(`SELECT * FROM room_members WHERE room_id = ? ORDER BY created_at, member_id`)
    .all(roomId) as RoomMemberRow[]
  return { ...room, members }
}

export function getRoomByName(this: OrchestrationDb, name: string): RoomWithMembers | undefined {
  const room = this.db
    .prepare(`SELECT * FROM rooms WHERE lower(name) = lower(?)`)
    .get(String(name).trim()) as RoomRow | undefined
  if (!room) return undefined
  return this.getRoom(room.id)
}

export function listRooms(this: OrchestrationDb): RoomWithMembers[] {
  const rows = this.db.prepare(`SELECT id FROM rooms ORDER BY created_at`).all() as { id: string }[]
  return rows.map((r) => this.getRoom(r.id)!).filter(Boolean)
}

/** Every room that carries this member, for reverse lookups (turn-completion watcher). */
export function roomsForMember(this: OrchestrationDb, memberId: string): RoomWithMembers[] {
  const rows = this.db
    .prepare(`SELECT room_id FROM room_members WHERE member_id = ?`)
    .all(memberId) as { room_id: string }[]
  return rows.map((r) => this.getRoom(r.room_id)!).filter(Boolean)
}

export function deleteRoom(this: OrchestrationDb, roomId: string): void {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    this.db.prepare(`DELETE FROM room_log WHERE room_id = ?`).run(roomId)
    this.db.prepare(`DELETE FROM room_members WHERE room_id = ?`).run(roomId)
    this.db.prepare(`DELETE FROM rooms WHERE id = ?`).run(roomId)
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function addRoomMember(
  this: OrchestrationDb,
  roomId: string,
  member: { memberId: string; name: string; isAdmin?: boolean }
): void {
  const name = String(member.name ?? '').trim()
  if (!name) throw invalid('A member needs a name')
  this.db
    .prepare(
      `INSERT INTO room_members (room_id, member_id, name, is_admin, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(roomId, member.memberId, name, member.isAdmin ? 1 : 0, new Date().toISOString())
}

export function removeRoomMember(this: OrchestrationDb, roomId: string, memberId: string): void {
  this.db
    .prepare(`DELETE FROM room_members WHERE room_id = ? AND member_id = ?`)
    .run(roomId, memberId)
}

export function setRoomWorktree(this: OrchestrationDb, roomId: string, worktree: string): void {
  this.db
    .prepare(`UPDATE rooms SET worktree = ?, updated_at = ? WHERE id = ?`)
    .run(String(worktree ?? ''), new Date().toISOString(), roomId)
}

export function markRoomMemberSeen(
  this: OrchestrationDb,
  roomId: string,
  memberId: string,
  seq: number
): void {
  this.db
    .prepare(
      `UPDATE room_members SET seen_seq = MAX(seen_seq, ?) WHERE room_id = ? AND member_id = ?`
    )
    .run(seq, roomId, memberId)
}

export function setRoomMemberSession(
  this: OrchestrationDb,
  roomId: string,
  memberId: string,
  sessionId: string | null
): void {
  this.db
    .prepare(`UPDATE room_members SET session_id = ? WHERE room_id = ? AND member_id = ?`)
    .run(sessionId, roomId, memberId)
}

/** Append a line and advance the room's sequence. Returns the new seq. */
export function appendRoomLine(
  this: OrchestrationDb,
  roomId: string,
  line: {
    who: string
    memberId?: string | null
    text: string
    kind?: RoomLogKind
    payload?: string
  }
): number {
  const insert = this.db.prepare(
    `INSERT INTO room_log (room_id, seq, who, member_id, text, kind, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const bump = this.db.prepare(`UPDATE rooms SET seq = ?, updated_at = ? WHERE id = ?`)
  const trim = this.db.prepare(`DELETE FROM room_log WHERE room_id = ? AND seq <= ?`)
  let seq = 0
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const row = this.db.prepare(`SELECT seq FROM rooms WHERE id = ?`).get(roomId) as
      | { seq: number }
      | undefined
    if (!row) throw invalid(`Room ${roomId} not found`)
    seq = row.seq + 1
    const now = new Date().toISOString()
    insert.run(
      roomId,
      seq,
      line.who,
      line.memberId ?? null,
      line.text,
      line.kind ?? null,
      line.payload ?? null
    )
    bump.run(seq, now, roomId)
    trim.run(roomId, seq - ROOM_LOG_MAX)
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
  return seq
}

/** Unread lines for a member: everything above its cursor, excluding its own writes. */
export function unseenRoomLines(
  this: OrchestrationDb,
  roomId: string,
  memberId: string,
  firstLookCount = 12,
  deltaMax = 24
): RoomLogRow[] {
  const member = this.db
    .prepare(`SELECT seen_seq FROM room_members WHERE room_id = ? AND member_id = ?`)
    .get(roomId, memberId) as { seen_seq: number } | undefined
  if (!member) return []
  if (member.seen_seq === 0) {
    // First look: pull the tail, still excluding the member's own writes.
    return this.db
      .prepare(
        `SELECT * FROM room_log
         WHERE room_id = ? AND (member_id IS NULL OR member_id != ?)
         ORDER BY seq DESC LIMIT ?`
      )
      .all(roomId, memberId, firstLookCount)
      .reverse() as RoomLogRow[]
  }
  return this.db
    .prepare(
      `SELECT * FROM room_log
       WHERE room_id = ? AND seq > ? AND (member_id IS NULL OR member_id != ?)
       ORDER BY seq DESC LIMIT ?`
    )
    .all(roomId, member.seen_seq, memberId, deltaMax)
    .reverse() as RoomLogRow[]
}

export type RoomStoreMethods = {
  createRoom: typeof createRoom
  getRoom: typeof getRoom
  getRoomByName: typeof getRoomByName
  listRooms: typeof listRooms
  roomsForMember: typeof roomsForMember
  deleteRoom: typeof deleteRoom
  addRoomMember: typeof addRoomMember
  removeRoomMember: typeof removeRoomMember
  setRoomWorktree: typeof setRoomWorktree
  markRoomMemberSeen: typeof markRoomMemberSeen
  setRoomMemberSession: typeof setRoomMemberSession
  appendRoomLine: typeof appendRoomLine
  unseenRoomLines: typeof unseenRoomLines
}

export function attachRoomStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createRoom,
    getRoom,
    getRoomByName,
    listRooms,
    roomsForMember,
    deleteRoom,
    addRoomMember,
    removeRoomMember,
    setRoomWorktree,
    markRoomMemberSeen,
    setRoomMemberSession,
    appendRoomLine,
    unseenRoomLines
  })
}
