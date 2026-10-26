import { useCallback, useEffect, useRef, useState } from 'react'
import type { TabGroupLayoutNode } from '../../../../shared/tab-types'
import { useAppStore } from '../../store'
import TabGroupPanel, { type TabGroupPanelTabStrip } from './TabGroupPanel'
import { subtreeHasChatGroup } from './subtree-chat-groups'
import type { HoveredTabInsertion } from './useTabDragSplit'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { setGroupRatioThroughLayoutOwner } from './tab-group-layout-owner-commands'

const MIN_RATIO = 0.15
const MAX_RATIO = 0.85

const EMPTY_CHAT_GROUP_IDS: ReadonlySet<string> = new Set()

// Why: Work/Code switches glide instead of snapping — the folded pane eases
// to zero flex with a fade while its sibling takes the row. Manual resize
// drags bypass the transition (see ResizeHandle) or the handle feels detached.
const SPLIT_PANE_CLASS =
  'flex min-w-0 min-h-0 flex-1 overflow-hidden transition-[flex-grow,opacity,visibility] duration-200 ease-out motion-reduce:transition-none'

function ResizeHandle({
  direction,
  onResizeStart,
  onResizeEnd,
  onRatioChange
}: {
  direction: 'horizontal' | 'vertical'
  onResizeStart: () => void
  onResizeEnd?: () => void
  onRatioChange: (ratio: number) => void
}): React.JSX.Element {
  const isHorizontal = direction === 'horizontal'
  const [dragging, setDragging] = useState(false)
  const activeResizeCleanupRef = useRef<((updateDragging?: boolean) => void) | null>(null)

  useEffect(
    () => () => {
      activeResizeCleanupRef.current?.(false)
    },
    []
  )

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      // Why: a second pointer must not steal or finalize the active gesture.
      if (activeResizeCleanupRef.current) {
        return
      }
      const handle = event.currentTarget
      const container = handle.parentElement
      if (!container) {
        return
      }
      const firstPane = handle.previousElementSibling as HTMLElement | null
      const secondPane = handle.nextElementSibling as HTMLElement | null
      if (!firstPane || !secondPane) {
        return
      }
      onResizeStart()
      setDragging(true)
      handle.setPointerCapture(event.pointerId)
      // Why: the panes ease width on mode switches — kill the transition
      // during a manual drag or the handle feels detached from the pointer.
      firstPane.style.transitionProperty = 'none'
      secondPane.style.transitionProperty = 'none'
      // Why: measure outside pointermove so pane writes never force a readback.
      let rect = container.getBoundingClientRect()
      const resizeObserver = new ResizeObserver(() => {
        rect = container.getBoundingClientRect()
      })
      resizeObserver.observe(container)
      let draggedRatio: number | null = null

      const onPointerMove = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== event.pointerId || !handle.hasPointerCapture(event.pointerId)) {
          return
        }
        const ratio = isHorizontal
          ? (moveEvent.clientX - rect.left) / rect.width
          : (moveEvent.clientY - rect.top) / rect.height
        const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
        draggedRatio = clamped
        // Write pane styles during drag to avoid 60–120 global store updates per second; commit once on release.
        firstPane.style.flex = `${clamped} 1 0%`
        secondPane.style.flex = `${1 - clamped} 1 0%`
      }

      let cleaned = false
      const cleanup = (updateDragging = true): void => {
        if (cleaned) {
          return
        }
        cleaned = true
        resizeObserver.disconnect()
        firstPane.style.transitionProperty = ''
        secondPane.style.transitionProperty = ''
        if (draggedRatio !== null) {
          onRatioChange(draggedRatio)
        }
        if (updateDragging) {
          setDragging(false)
        }
        try {
          if (handle.hasPointerCapture(event.pointerId)) {
            handle.releasePointerCapture(event.pointerId)
          }
        } catch {
          // Best effort: unmount cleanup can run after Chromium has already dropped capture.
        }
        handle.removeEventListener('pointermove', onPointerMove)
        handle.removeEventListener('pointerup', onPointerUp)
        handle.removeEventListener('pointercancel', onPointerCancel)
        handle.removeEventListener('lostpointercapture', onLostPointerCapture)
        if (activeResizeCleanupRef.current === cleanup) {
          activeResizeCleanupRef.current = null
        }
      }

      const onPointerUp = (upEvent: PointerEvent): void => {
        if (upEvent.pointerId === event.pointerId) {
          cleanup()
        }
      }

      const onPointerCancel = (cancelEvent: PointerEvent): void => {
        if (cancelEvent.pointerId === event.pointerId) {
          cleanup()
        }
      }

      const onLostPointerCapture = (lostEvent: PointerEvent): void => {
        if (lostEvent.pointerId === event.pointerId) {
          cleanup()
        }
      }

      handle.addEventListener('pointermove', onPointerMove)
      handle.addEventListener('pointerup', onPointerUp)
      handle.addEventListener('pointercancel', onPointerCancel)
      handle.addEventListener('lostpointercapture', onLostPointerCapture)
      activeResizeCleanupRef.current = cleanup
    },
    [isHorizontal, onRatioChange, onResizeStart, onResizeEnd]
  )

  return (
    <div
      className={`tab-group-split-resize-handle ${
        isHorizontal ? 'is-vertical' : 'is-horizontal'
      }${dragging ? ' is-dragging' : ''}`}
      onPointerDown={onPointerDown}
    />
  )
}

function SplitNode({
  node,
  nodePath,
  worktreeId,
  focusedGroupId,
  isWorktreeActive,
  hasSplitGroups,
  tabStrip,
  markdownAnnotationsEnabled,
  touchesTopEdge,
  touchesRightEdge,
  touchesLeftEdge,
  touchesBottomEdge,
  suppressLeftBorder,
  suppressRightBorder,
  suppressBottomBorder,
  isTabDragActive,
  hoveredTabInsertion,
  collapseNonChatGroups,
  chatGroupIds
}: {
  node: TabGroupLayoutNode
  nodePath: string
  worktreeId: string
  focusedGroupId?: string
  isWorktreeActive: boolean
  hasSplitGroups: boolean
  tabStrip: TabGroupPanelTabStrip
  markdownAnnotationsEnabled: boolean
  touchesTopEdge: boolean
  touchesRightEdge: boolean
  touchesLeftEdge: boolean
  touchesBottomEdge: boolean
  suppressLeftBorder: boolean
  suppressRightBorder: boolean
  suppressBottomBorder: boolean
  isTabDragActive: boolean
  hoveredTabInsertion: HoveredTabInsertion | null
  collapseNonChatGroups: boolean
  chatGroupIds: ReadonlySet<string>
}): React.JSX.Element {
  const setTabGroupSplitRatio = useAppStore((state) => state.setTabGroupSplitRatio)
  const recordFeatureInteraction = useAppStore((state) => state.recordFeatureInteraction)
  // Why: a worktree with no chat group at all keeps its full layout instead of a blank screen.
  const canCollapse = collapseNonChatGroups && chatGroupIds.size > 0

  if (node.type === 'leaf') {
    // Why: folding is owned by the branch wrappers above (they ease to zero
    // flex with a fade), so leaves stay mounted and never snap themselves —
    // terminals keep running and editors keep state across mode switches.
    return (
      <div className="flex min-w-0 min-h-0 flex-1">
        <TabGroupPanel
          groupId={node.groupId}
          worktreeId={worktreeId}
          isVisible={isWorktreeActive}
          // Why: hidden worktrees stay mounted so their PTYs and split layouts
          // survive worktree switches, but only the visible worktree may own the
          // global terminal shortcuts. If an offscreen group's pane stays
          // "focused", Cmd/Ctrl+W and split shortcuts can hit the wrong worktree.
          isFocused={isWorktreeActive && node.groupId === focusedGroupId}
          hasSplitGroups={hasSplitGroups}
          tabStrip={tabStrip}
          markdownAnnotationsEnabled={markdownAnnotationsEnabled}
          touchesRightEdge={touchesRightEdge}
          touchesLeftEdge={touchesLeftEdge}
          touchesBottomEdge={touchesBottomEdge}
          suppressLeftBorder={suppressLeftBorder}
          suppressRightBorder={suppressRightBorder}
          suppressBottomBorder={suppressBottomBorder}
          reserveClosedExplorerToggleSpace={touchesTopEdge && touchesRightEdge}
          reserveCollapsedSidebarHeaderSpace={touchesTopEdge && touchesLeftEdge}
          isTabDragActive={isTabDragActive}
          hoveredTabInsertion={
            hoveredTabInsertion?.groupId === node.groupId ? hoveredTabInsertion : null
          }
        />
      </div>
    )
  }

  const isHorizontal = node.direction === 'horizontal'
  const ratio = node.ratio ?? 0.5
  const firstHasChat = subtreeHasChatGroup(node.first, chatGroupIds)
  const secondHasChat = subtreeHasChatGroup(node.second, chatGroupIds)
  // Why: hide only the chat-free side, and only while the other side keeps something
  // visible — the resize handle goes too, since it would float beside a hidden pane.
  const hideFirst = canCollapse && !firstHasChat && secondHasChat
  const hideSecond = canCollapse && !secondHasChat && firstHasChat

  // Why: a folded sibling eases to zero flex (never `hidden`, which can't
  // transition) while the visible pane takes the full row/column.
  const firstFlex = hideFirst ? '0 1 0%' : hideSecond ? '1 1 0%' : `${ratio} 1 0%`
  const secondFlex = hideSecond ? '0 1 0%' : hideFirst ? '1 1 0%' : `${1 - ratio} 1 0%`

  return (
    <div
      className="flex flex-1 min-w-0 min-h-0 overflow-hidden"
      style={{ flexDirection: isHorizontal ? 'row' : 'column' }}
    >
      <div
        className={hideFirst ? `${SPLIT_PANE_CLASS} invisible opacity-0` : SPLIT_PANE_CLASS}
        style={{ flex: firstFlex }}
      >
        <SplitNode
          node={node.first}
          nodePath={nodePath.length > 0 ? `${nodePath}.first` : 'first'}
          worktreeId={worktreeId}
          focusedGroupId={focusedGroupId}
          isWorktreeActive={isWorktreeActive}
          hasSplitGroups={hasSplitGroups}
          tabStrip={tabStrip}
          markdownAnnotationsEnabled={markdownAnnotationsEnabled}
          touchesTopEdge={touchesTopEdge}
          // Why: a folded second eases to zero flex, so the first owns the window
          // corner — its strip must still reserve the toggle + window-controls space.
          touchesRightEdge={isHorizontal ? hideSecond : touchesRightEdge}
          touchesLeftEdge={touchesLeftEdge}
          touchesBottomEdge={isHorizontal ? touchesBottomEdge : false}
          suppressLeftBorder={suppressLeftBorder}
          // The resize handle owns the inner seam; pane borders would stack into extra lines.
          suppressRightBorder={isHorizontal ? true : suppressRightBorder}
          suppressBottomBorder={isHorizontal ? suppressBottomBorder : true}
          isTabDragActive={isTabDragActive}
          hoveredTabInsertion={hoveredTabInsertion}
          collapseNonChatGroups={collapseNonChatGroups}
          chatGroupIds={chatGroupIds}
        />
      </div>
      {hideFirst || hideSecond ? null : (
        <ResizeHandle
          direction={node.direction}
          onResizeStart={() => recordFeatureInteraction('terminal-panes')}
          onRatioChange={(nextRatio) =>
            // Switch point: main saves the group sizes once the drag ends.
            ORCA_LAYOUT_OWNER_IS_MAIN
              ? setGroupRatioThroughLayoutOwner(worktreeId, nodePath, nextRatio)
              : setTabGroupSplitRatio(worktreeId, nodePath, nextRatio)
          }
        />
      )}
      <div
        className={hideSecond ? `${SPLIT_PANE_CLASS} invisible opacity-0` : SPLIT_PANE_CLASS}
        style={{ flex: secondFlex }}
      >
        <SplitNode
          node={node.second}
          nodePath={nodePath.length > 0 ? `${nodePath}.second` : 'second'}
          worktreeId={worktreeId}
          focusedGroupId={focusedGroupId}
          isWorktreeActive={isWorktreeActive}
          hasSplitGroups={hasSplitGroups}
          tabStrip={tabStrip}
          markdownAnnotationsEnabled={markdownAnnotationsEnabled}
          // Why: a folded first eases to zero flex, so the second owns the top
          // edge and corner — its strip must still reserve the chrome space.
          touchesTopEdge={isHorizontal ? touchesTopEdge : hideFirst}
          touchesRightEdge={touchesRightEdge}
          // Why: same fold — the second owns the left edge, so the collapsed
          // sidebar toggle spacer still applies to its strip.
          touchesLeftEdge={isHorizontal ? hideFirst : touchesLeftEdge}
          touchesBottomEdge={touchesBottomEdge}
          suppressLeftBorder={isHorizontal ? true : suppressLeftBorder}
          suppressRightBorder={suppressRightBorder}
          suppressBottomBorder={suppressBottomBorder}
          isTabDragActive={isTabDragActive}
          hoveredTabInsertion={hoveredTabInsertion}
          collapseNonChatGroups={collapseNonChatGroups}
          chatGroupIds={chatGroupIds}
        />
      </div>
    </div>
  )
}

/** Host this chrome-free tree in a sized flex container or panes collapse; the host owns drag scope and outer seams. */
export function TabGroupSplitNodeTree({
  layout,
  worktreeId,
  focusedGroupId,
  isWorktreeActive,
  isTabDragActive,
  hoveredTabInsertion,
  tabStrip = 'attached',
  markdownAnnotationsEnabled = true,
  rootTouchesBottomEdge = false,
  collapseNonChatGroups = false,
  chatGroupIds = EMPTY_CHAT_GROUP_IDS
}: {
  layout: TabGroupLayoutNode
  worktreeId: string
  focusedGroupId?: string
  isWorktreeActive: boolean
  isTabDragActive: boolean
  hoveredTabInsertion: HoveredTabInsertion | null
  tabStrip?: TabGroupPanelTabStrip
  /** Off for scratch workspaces (the floating panel) whose markdown is not a review surface. */
  markdownAnnotationsEnabled?: boolean
  /** True when the host's own chrome bounds the tree's bottom edge (no border-b to paint). */
  rootTouchesBottomEdge?: boolean
  /** Work mode: fold every non-chat pane behind `hidden` instead of unmounting it. */
  collapseNonChatGroups?: boolean
  /** Chat-panel group ids of the worktree; the collapse keeps-alive set. */
  chatGroupIds?: ReadonlySet<string>
}): React.JSX.Element {
  return (
    <SplitNode
      node={layout}
      nodePath=""
      worktreeId={worktreeId}
      focusedGroupId={focusedGroupId}
      isWorktreeActive={isWorktreeActive}
      hasSplitGroups={layout.type === 'split'}
      tabStrip={tabStrip}
      markdownAnnotationsEnabled={markdownAnnotationsEnabled}
      touchesTopEdge={true}
      touchesRightEdge={true}
      touchesLeftEdge={true}
      touchesBottomEdge={rootTouchesBottomEdge}
      suppressLeftBorder={false}
      suppressRightBorder={false}
      suppressBottomBorder={false}
      isTabDragActive={isTabDragActive}
      hoveredTabInsertion={hoveredTabInsertion}
      collapseNonChatGroups={collapseNonChatGroups}
      chatGroupIds={chatGroupIds}
    />
  )
}
