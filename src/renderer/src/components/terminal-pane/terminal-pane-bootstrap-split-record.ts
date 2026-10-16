import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import { recordLayoutApply } from '@/runtime/layout-apply-send'

export type BootstrapSplitManager = Pick<
  PaneManager,
  'getActivePane' | 'getPanes' | 'setActivePane' | 'splitPane'
>

/**
 * The manager a tab's startup splits use in a layout-owner build: each split is drawn at once
 * under the window's pane id (its startup command rides on the split), then recorded in main.
 */
export function recordingBootstrapSplits(
  manager: PaneManager,
  worktreeId: string,
  tabId: string
): BootstrapSplitManager {
  return {
    getActivePane: () => manager.getActivePane(),
    getPanes: () => manager.getPanes(),
    setActivePane: (paneId, opts) => manager.setActivePane(paneId, opts),
    splitPane: (paneId, direction, options) => {
      const sourceLeafId = manager.getLeafId(paneId)
      const created = manager.splitPane(paneId, direction, options)
      if (created && sourceLeafId) {
        recordDrawnPaneSplit(worktreeId, tabId, sourceLeafId, direction, created.leafId)
      }
      return created
    }
  }
}

/**
 * Records a split the window drew under its pane id. Main finds the pane it already holds and
 * changes nothing, or writes it again (one main took back while the window mounted it late).
 */
export function recordDrawnPaneSplit(
  worktreeId: string,
  tabId: string,
  sourceLeafId: string,
  direction: 'vertical' | 'horizontal',
  newLeafId: string
): void {
  recordLayoutApply(useAppStore.getState(), worktreeId, {
    type: 'splitPane',
    tabId,
    leafId: sourceLeafId,
    direction,
    newLeafId
  })
}
