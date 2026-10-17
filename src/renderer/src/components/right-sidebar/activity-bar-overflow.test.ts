import { describe, expect, it } from 'vitest'
import type { ActiveRightSidebarTab } from '@/store/slices/editor'
import { getDshHeaderTabLayout, getTopActivityBarLayout } from './activity-bar-overflow'

const items = (['explorer', 'source-control', 'checks', 'ports'] as ActiveRightSidebarTab[]).map(
  (id) => ({ id })
)

const dshItems = [
  { id: 'explorer' as ActiveRightSidebarTab, title: 'Explorer' },
  { id: 'source-control' as ActiveRightSidebarTab, title: 'Source Control' },
  { id: 'checks' as ActiveRightSidebarTab, title: 'Checks' }
]

describe('getTopActivityBarLayout', () => {
  it('shows every item when the top activity strip has enough room', () => {
    const layout = getTopActivityBarLayout(items, 144, 'explorer')

    expect(layout.visibleItems.map((item) => item.id)).toEqual([
      'explorer',
      'source-control',
      'checks',
      'ports'
    ])
    expect(layout.overflowItems).toEqual([])
  })

  it('moves trailing items behind the overflow menu when width is tight', () => {
    const layout = getTopActivityBarLayout(items, 124, 'explorer')

    expect(layout.visibleItems.map((item) => item.id)).toEqual(['explorer', 'source-control'])
    expect(layout.overflowItems.map((item) => item.id)).toEqual(['checks', 'ports'])
  })

  it('keeps the active tab visible even when it would otherwise overflow', () => {
    const layout = getTopActivityBarLayout(items, 124, 'ports')

    expect(layout.visibleItems.map((item) => item.id)).toEqual(['explorer', 'ports'])
    expect(layout.overflowItems.map((item) => item.id)).toEqual(['source-control', 'checks'])
  })
})

describe('getDshHeaderTabLayout', () => {
  it('shows every tab when the header has enough room', () => {
    const layout = getDshHeaderTabLayout(dshItems, 600, 'explorer')

    expect(layout.visibleItems.map((item) => item.id)).toEqual([
      'explorer',
      'source-control',
      'checks'
    ])
    expect(layout.overflowItems).toEqual([])
  })

  it('moves trailing tabs behind the overflow menu when width is tight', () => {
    const layout = getDshHeaderTabLayout(dshItems, 220, 'explorer')

    expect(layout.visibleItems.map((item) => item.id)).toEqual(['explorer'])
    expect(layout.overflowItems.map((item) => item.id)).toEqual(['source-control', 'checks'])
  })

  it('keeps the active tab visible even when it would otherwise overflow', () => {
    const layout = getDshHeaderTabLayout(dshItems, 220, 'checks')

    expect(layout.visibleItems.map((item) => item.id)).toEqual(['checks'])
    expect(layout.overflowItems.map((item) => item.id)).toEqual(['explorer', 'source-control'])
  })
})
