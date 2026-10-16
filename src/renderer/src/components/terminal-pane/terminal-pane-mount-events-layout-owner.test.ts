// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyConnectionDeps } from './pty-connection-types'
import { installTerminalPaneMountEvents } from './terminal-pane-mount-events'
import {
  _resetTerminalPaneSplitRequestRoutingForTests,
  dispatchTerminalPaneSplitRequest
} from './terminal-pane-split-request-routing'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
const recordLayoutApply = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/layout-apply-send', () => ({ recordLayoutApply }))
const storeState = vi.hoisted(() => ({ recordFeatureInteraction: () => {} }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))

const SOURCE = '11111111-1111-4111-8111-111111111111'
const NEW = '22222222-2222-4222-8222-222222222222'

function mountedTab(): { manager: PaneManager; splitPane: ReturnType<typeof vi.fn> } {
  const leafById = new Map<number, string>([[1, SOURCE]])
  const splitPane = vi.fn((_paneId: number, _direction: string, opts?: { leafId?: string }) => {
    const leafId = opts?.leafId ?? 'window-minted'
    leafById.set(2, leafId)
    return { id: 2, leafId }
  })
  const manager = {
    splitPane,
    getLeafId: (paneId: number) => leafById.get(paneId) ?? null,
    getNumericIdForLeaf: (leafId: string) =>
      [...leafById].find(([, id]) => id === leafId)?.[0] ?? null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the split handler calls only these manager methods.
  return { manager: manager as unknown as PaneManager, splitPane }
}

function install(manager: PaneManager): () => void {
  return installTerminalPaneMountEvents({
    manager,
    deps: {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: true,
      managerRef: { current: manager },
      persistLayoutSnapshot: vi.fn(),
      syncCanExpandState: vi.fn(),
      queueResizeAll: vi.fn()
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a split with no startup command reads no pty deps.
    ptyDeps: {} as PtyConnectionDeps
  })
}

describe('a split main asked for, mounted in a layout-owner build', () => {
  afterEach(() => {
    recordLayoutApply.mockReset()
    _resetTerminalPaneSplitRequestRoutingForTests()
  })

  it('records the mounted pane in main, so a pane main took back meanwhile returns', () => {
    const { manager, splitPane } = mountedTab()
    const uninstall = install(manager)

    dispatchTerminalPaneSplitRequest({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      paneRuntimeId: 1,
      sourceLeafId: SOURCE,
      direction: 'vertical',
      newLeafId: NEW
    })

    expect(splitPane).toHaveBeenCalledWith(1, 'vertical', { leafId: NEW })
    expect(recordLayoutApply).toHaveBeenCalledWith(storeState, 'wt-1', {
      type: 'splitPane',
      tabId: 'tab-1',
      leafId: SOURCE,
      direction: 'vertical',
      newLeafId: NEW
    })
    uninstall()
  })

  it('records nothing for a split that names no pane id', () => {
    const { manager } = mountedTab()
    const uninstall = install(manager)

    dispatchTerminalPaneSplitRequest({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      paneRuntimeId: 1,
      sourceLeafId: SOURCE,
      direction: 'horizontal'
    })

    expect(recordLayoutApply).not.toHaveBeenCalled()
    uninstall()
  })
})
