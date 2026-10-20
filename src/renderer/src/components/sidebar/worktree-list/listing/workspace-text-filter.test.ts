import { describe, expect, it } from 'vitest'
import {
  didWorkspaceTextQueryHitLimit,
  filterWorktreesByTextQuery,
  matchesWorkspaceTextQuery
} from './workspace-text-filter'

const repoMap = new Map([
  ['r1', { displayName: 'Atlas' }],
  ['r2', { displayName: 'Beacon' }]
])

const rows = [
  { displayName: 'Checkout Red', path: '/repo/red', branch: 'feat-red', repoId: 'r1' },
  { displayName: 'Checkout Blue', path: '/repo/blue', branch: 'main', repoId: 'r2' }
] as const

describe('matchesWorkspaceTextQuery', () => {
  it('blank query matches everything', () => {
    expect(matchesWorkspaceTextQuery(rows[0], 'Atlas', '   ')).toBe(true)
  })
  it('matches display name case-insensitively', () => {
    expect(matchesWorkspaceTextQuery(rows[0], 'Atlas', 'RED')).toBe(true)
    expect(matchesWorkspaceTextQuery(rows[1], 'Beacon', 'RED')).toBe(false)
  })
  it('matches path, branch, and repo display name', () => {
    expect(matchesWorkspaceTextQuery(rows[1], 'Beacon', '/repo/blue')).toBe(true)
    expect(matchesWorkspaceTextQuery(rows[1], 'Beacon', 'MAIN')).toBe(true)
    expect(matchesWorkspaceTextQuery(rows[0], 'Atlas', 'atlas')).toBe(true)
  })
})

describe('filterWorktreesByTextQuery', () => {
  it('blank query keeps row order with a fresh array', () => {
    const out = filterWorktreesByTextQuery([...rows], repoMap, '')
    expect(out).toHaveLength(2)
    expect(out).not.toBe(rows)
  })
  it('filters to the matching row only', () => {
    const out = filterWorktreesByTextQuery([...rows], repoMap, 'blue')
    expect(out.map((row) => row.displayName)).toEqual(['Checkout Blue'])
  })
  it('caps a non-blank query at one flat page', () => {
    const many = Array.from({ length: 25 }, (_, index) => ({
      displayName: `Checkout ${index}`,
      path: `/repo/${index}`,
      branch: 'main',
      repoId: 'r1'
    }))
    const out = filterWorktreesByTextQuery(many, repoMap, 'checkout')
    expect(out).toHaveLength(20)
    expect(out[0]?.displayName).toBe('Checkout 0')
    expect(out[19]?.displayName).toBe('Checkout 19')
  })
})

describe('didWorkspaceTextQueryHitLimit', () => {
  it('blank query never hits the limit', () => {
    expect(didWorkspaceTextQueryHitLimit([...rows], repoMap, '   ')).toBe(false)
  })
  it('under the cap reports false', () => {
    expect(didWorkspaceTextQueryHitLimit([...rows], repoMap, 'checkout')).toBe(false)
  })
  it('more matches than the cap reports true', () => {
    const many = Array.from({ length: 21 }, (_, index) => ({
      displayName: `Checkout ${index}`,
      path: `/repo/${index}`,
      branch: 'main',
      repoId: 'r1'
    }))
    expect(didWorkspaceTextQueryHitLimit(many, repoMap, 'checkout')).toBe(true)
    expect(didWorkspaceTextQueryHitLimit(many.slice(0, 20), repoMap, 'checkout')).toBe(false)
  })
})
