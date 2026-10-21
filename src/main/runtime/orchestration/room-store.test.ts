import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

const open = () => new OrchestrationDb(':memory:')

const alice = { memberId: 'orca_session_id:alice', name: 'alice', isAdmin: true }
const beta = { memberId: 'orca_session_id:beta', name: 'beta' }

describe('room store', () => {
  it('creates a room and its members', () => {
    const db = open()
    const room = db.createRoom({
      name: 'writers',
      members: [alice, beta]
    })
    expect(room.name).toBe('writers')
    expect(room.mode).toBe('admin')
    expect(room.admin_member_id).toBe(alice.memberId)
    expect(room.members).toHaveLength(2)
    expect(room.members.map((m) => m.name).sort()).toEqual(['alice', 'beta'])
  })

  it('finds a room by name case-insensitively', () => {
    const db = open()
    const created = db.createRoom({ name: 'Writers', members: [alice] })
    expect(db.getRoomByName('writers')?.id).toBe(created.id)
    expect(db.getRoomByName('WRITERS')?.id).toBe(created.id)
    expect(db.getRoomByName('nobody')).toBeUndefined()
  })

  it('appends lines and bumps seq in order', () => {
    const db = open()
    const room = db.createRoom({ name: 'log', members: [alice, beta] })
    const s1 = db.appendRoomLine(room.id, { who: 'User', text: 'first' })
    const s2 = db.appendRoomLine(room.id, {
      who: 'alice',
      memberId: alice.memberId,
      text: 'hi'
    })
    const s3 = db.appendRoomLine(room.id, { who: 'User', text: 'again' })
    expect([s1, s2, s3]).toEqual([1, 2, 3])
    expect(db.getRoom(room.id)?.seq).toBe(3)
  })

  it('tracks per-member read cursor', () => {
    const db = open()
    const room = db.createRoom({ name: 'cur', members: [alice, beta] })
    db.appendRoomLine(room.id, { who: 'User', text: 'l1' })
    db.appendRoomLine(room.id, {
      who: 'alice',
      memberId: alice.memberId,
      text: 'l2'
    })
    db.appendRoomLine(room.id, { who: 'User', text: 'l3' })

    const betaUnseen = db.unseenRoomLines(room.id, beta.memberId)
    // beta saw nothing: the first-look pulls the tail (up to 12)
    expect(betaUnseen.map((l) => l.text)).toEqual(['l1', 'l2', 'l3'])

    db.markRoomMemberSeen(room.id, beta.memberId, 2)
    const next = db.unseenRoomLines(room.id, beta.memberId)
    expect(next.map((l) => l.text)).toEqual(['l3'])

    // alice excludes her own line
    const aliceUnseen = db.unseenRoomLines(room.id, alice.memberId)
    expect(aliceUnseen.map((l) => l.text)).toEqual(['l1', 'l3'])
  })

  it('removes members and rooms', () => {
    const db = open()
    const room = db.createRoom({ name: 'x', members: [alice, beta] })
    db.removeRoomMember(room.id, beta.memberId)
    expect(db.getRoom(room.id)?.members.map((m) => m.member_id)).toEqual([alice.memberId])
    db.deleteRoom(room.id)
    expect(db.getRoom(room.id)).toBeUndefined()
    expect(db.getRoomByName('x')).toBeUndefined()
  })
})
