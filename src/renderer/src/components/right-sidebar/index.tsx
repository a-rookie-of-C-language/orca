import React, { useMemo, useState } from 'react'
import { PanelLeft, PanelRight } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { getDshHeaderTabLayout, getTopActivityBarLayout } from './activity-bar-overflow'
import { RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME } from './right-sidebar-titlebar-drag-regions'
import { getActiveChecksStatus } from './active-checks-status'
import {
  RIGHT_SIDEBAR_MIN_WIDTH,
  clampRightSidebarPanelWidth,
  computeMaxRightSidebarPanelWidth
} from './right-sidebar-width'
import { translate } from '@/i18n/i18n'
import { RightSidebarPanelContent } from './right-sidebar-panel-content'
import { useMeasuredWidth } from './right-sidebar-measured-width'
import {
  isPairedWebClientWindow,
  shouldRenderDesktopWindowChrome
} from '@/lib/desktop-window-chrome'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { ActivityBarPositionMenu } from './activity-bar-position-menu'
import {
  ActivityBarButton,
  TopActivityOverflowMenu,
  activityItemAriaLabel
} from './activity-bar-buttons'
import { RightSidebarTopActivityBar } from './right-sidebar-top-activity-bar'
import { useRightSidebarActivityItems } from './use-right-sidebar-activity-items'
import { useRightSidebarTabRouting } from './use-right-sidebar-tab-routing'
import { useWindowWidth } from './use-window-width'

function RightSidebarInner({
  side = 'right',
  reserveTitlebarSpace = false
}: {
  side?: 'left' | 'right'
  reserveTitlebarSpace?: boolean
}): React.JSX.Element {
  const onLeft = side === 'left'
  const ToggleIcon = onLeft ? PanelLeft : PanelRight
  const sideDshLayout = !onLeft
  const hasDesktopWindowChrome = shouldRenderDesktopWindowChrome({
    platform: getRendererAppPlatform(),
    isWebClient: isPairedWebClientWindow()
  })
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarWidth = useAppStore((s) => s.rightSidebarWidth)
  const setRightSidebarWidth = useAppStore((s) => s.setRightSidebarWidth)
  const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar)
  const checksStatus = useAppStore((s) => (s.rightSidebarOpen ? getActiveChecksStatus(s) : null))
  const activityBarPosition = useAppStore((s) => s.activityBarPosition)
  const setActivityBarPosition = useAppStore((s) => s.setActivityBarPosition)
  const [topActivityStripWidth, setTopActivityStripWidth] = useState<number | null>(null)
  const {
    visibleItems,
    activeFolderWorkspaceKey,
    pluginSystemEnabled,
    pluginFetchStatus,
    installedPluginTabKeys
  } = useRightSidebarActivityItems({ rightSidebarOpen })
  const { effectiveTab, selectActivityTab } = useRightSidebarTabRouting({
    visibleItems,
    activeFolderWorkspaceKey,
    pluginSystemEnabled,
    pluginFetchStatus,
    installedPluginTabKeys
  })
  const panelVisible = rightSidebarOpen

  // Why: the right-side DSH layout folds tabs into a header strip instead of a 40px icon rail.
  const activityBarSideWidth = sideDshLayout ? 0 : activityBarPosition === 'side' ? 40 : 0
  const windowWidth = useWindowWidth()
  const maxWidth = computeMaxRightSidebarPanelWidth(windowWidth, activityBarSideWidth)
  const renderedRightSidebarWidth = clampRightSidebarPanelWidth(
    rightSidebarWidth,
    windowWidth,
    activityBarSideWidth
  )
  const { containerRef, onResizeStart, isResizing } = useSidebarResize<HTMLDivElement>({
    isOpen: panelVisible,
    width: renderedRightSidebarWidth,
    minWidth: RIGHT_SIDEBAR_MIN_WIDTH,
    maxWidth,
    deltaSign: onLeft ? 1 : -1,
    renderedExtraWidth: activityBarSideWidth,
    setWidth: setRightSidebarWidth
  })
  const topActivityStripRef = useMeasuredWidth(setTopActivityStripWidth)

  const panelContent = rightSidebarOpen ? (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden scrollbar-sleek-parent">
      {/* Keep panels mounted across worktree switches; remounts caused Windows IPC storms and multi-second freezes. */}
      <RightSidebarPanelContent effectiveTab={effectiveTab} rightSidebarOpen={rightSidebarOpen} />
    </div>
  ) : null

  const topActivityLayout = useMemo(
    () => getTopActivityBarLayout(visibleItems, topActivityStripWidth, effectiveTab),
    [visibleItems, topActivityStripWidth, effectiveTab]
  )

  // Why: DSH text tabs share the top strip's measured width so squeezed
  // panels fold trailing tabs behind More instead of truncating labels.
  const dshHeaderLayout = useMemo(
    () =>
      sideDshLayout
        ? getDshHeaderTabLayout(visibleItems, topActivityStripWidth, effectiveTab)
        : { visibleItems, overflowItems: [] as typeof visibleItems },
    [sideDshLayout, visibleItems, topActivityStripWidth, effectiveTab]
  )

  const closeButton = rightSidebarOpen ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="sidebar-toggle mr-1"
          onClick={toggleRightSidebar}
          aria-label={translate(
            'auto.components.right.sidebar.index.e8e2e4ce74',
            'Toggle tools sidebar'
          )}
        >
          <ToggleIcon size={16} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {translate('auto.components.right.sidebar.index.9fffaf17c1', 'Toggle tools sidebar')}
      </TooltipContent>
    </Tooltip>
  ) : null

  const sideActivityBarIcons = visibleItems.map((item) => (
    <ActivityBarButton
      key={item.id}
      item={item}
      active={effectiveTab === item.id}
      onClick={() => selectActivityTab(item.id)}
      layout="side"
      sidebarSide={side}
      statusIndicator={item.id === 'checks' ? checksStatus : null}
    />
  ))

  // Why: DSH-style text tabs only replace the icon rail on the right side; the left keeps VS Code chrome.
  const dshHeaderTabs = sideDshLayout ? (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            // Why: the DSH header stretches to the window edge (no 40px icon
            // rail), so it needs the full window-controls inset. The side
            // inset subtracts 40px for a rail that doesn't exist here and
            // slides the fold/close buttons under the overlay.
            'flex h-9 min-h-9 items-center gap-1 border-b border-border px-2 right-sidebar-header-drag right-sidebar-header-inset'
          )}
        >
          <TooltipProvider delayDuration={400}>
            <nav
              ref={topActivityStripRef}
              className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
              aria-label={translate('auto.components.right.sidebar.index.8bc2bbc3a0', 'Explorer')}
            >
              {dshHeaderLayout.visibleItems.map((item) => {
                const active = effectiveTab === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-tools-sidebar-tab={item.id}
                    title={item.title}
                    aria-label={activityItemAriaLabel(item)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      RIGHT_SIDEBAR_HEADER_NO_DRAG_CLASS_NAME,
                      'min-w-0 max-w-40 truncate rounded-md px-2 py-1 text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                    )}
                    onClick={() => selectActivityTab(item.id)}
                  >
                    {item.title}
                  </button>
                )
              })}
              {dshHeaderLayout.overflowItems.length > 0 ? (
                <TopActivityOverflowMenu
                  items={dshHeaderLayout.overflowItems}
                  activeTab={effectiveTab}
                  onSelect={selectActivityTab}
                  checksStatus={checksStatus}
                />
              ) : null}
            </nav>
            <div className="flex shrink-0 items-center">{closeButton}</div>
          </TooltipProvider>
        </div>
      </ContextMenuTrigger>
      <ActivityBarPositionMenu
        currentPosition={activityBarPosition}
        onChangePosition={setActivityBarPosition}
      />
    </ContextMenu>
  ) : null

  return (
    <div
      ref={containerRef}
      data-tools-sidebar-side={side}
      className={cn(
        'relative flex-shrink-0 flex flex-row',
        reserveTitlebarSpace && 'pt-9 bg-sidebar',
        // Why: Work/Code switches glide the tools sidebar open and shut;
        // manual drags keep the transition off or the handle feels detached.
        !isResizing && 'transition-[width] duration-200 ease-out motion-reduce:transition-none',
        // Why: overflow-visible is needed when open so the resize handle
        // on the outer edge remains interactive.  When closed (width 0),
        // switch to overflow-hidden so the activity bar icons and panel
        // content don't leak past the 0-width boundary (the component
        // stays mounted for performance — see App.tsx).
        panelVisible ? 'overflow-visible' : 'overflow-hidden'
      )}
    >
      <div
        className="flex flex-col flex-1 min-w-0 bg-sidebar overflow-hidden"
        style={{
          borderLeft: !onLeft && rightSidebarOpen ? '1px solid var(--sidebar-border)' : 'none',
          borderRight: onLeft && rightSidebarOpen ? '1px solid var(--sidebar-border)' : 'none'
        }}
      >
        {sideDshLayout ? (
          dshHeaderTabs
        ) : activityBarPosition === 'top' ? (
          <RightSidebarTopActivityBar
            hasDesktopWindowChrome={hasDesktopWindowChrome && !onLeft}
            atWindowEdge={!onLeft}
            topActivityStripRef={topActivityStripRef}
            topActivityLayout={topActivityLayout}
            effectiveTab={effectiveTab}
            onSelectTab={selectActivityTab}
            checksStatus={checksStatus}
            closeButton={closeButton}
            activityBarPosition={activityBarPosition}
            onChangeActivityBarPosition={setActivityBarPosition}
          />
        ) : onLeft && reserveTitlebarSpace ? null : (
          /* ── Side layout: static title header (VS Code parity) ── */
          <div
            className={cn(
              'flex items-center justify-between h-[36px] min-h-[36px] px-3 border-b border-border right-sidebar-header-drag',
              !onLeft && 'right-sidebar-header-side-inset'
            )}
          >
            <span className="text-2xs font-semibold uppercase tracking-wider text-foreground">
              {visibleItems.find((item) => item.id === effectiveTab)?.title ?? ''}
            </span>
            <TooltipProvider delayDuration={400}>
              <div className="flex items-center">{closeButton}</div>
            </TooltipProvider>
          </div>
        )}

        {panelContent}

        {/* Resize from the edge facing the workbench. */}
        <div
          data-tools-sidebar-resize=""
          className={cn(
            'absolute top-0 w-1 h-full cursor-col-resize hover:bg-ring/20 active:bg-ring/30 transition-colors z-10',
            onLeft ? 'right-0' : 'left-0'
          )}
          onMouseDown={onResizeStart}
        />
      </div>

      {/* Keep the activity strip on the outside edge in either layout. */}
      {!sideDshLayout && activityBarPosition === 'side' && (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              className={cn(
                'flex min-h-0 w-10 shrink-0 flex-col items-center bg-sidebar border-border',
                onLeft ? 'order-first border-r' : 'border-l side-activity-bar-windows-inset'
              )}
            >
              <TooltipProvider delayDuration={400}>
                <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-sleek">
                  {sideActivityBarIcons}
                </div>
                {onLeft && reserveTitlebarSpace ? (
                  <div className="flex h-10 shrink-0 items-center justify-center border-t border-border">
                    {closeButton}
                  </div>
                ) : null}
              </TooltipProvider>
            </div>
          </ContextMenuTrigger>
          <ActivityBarPositionMenu
            currentPosition={activityBarPosition}
            onChangePosition={setActivityBarPosition}
          />
        </ContextMenu>
      )}
    </div>
  )
}

const RightSidebar = React.memo(RightSidebarInner)
export default RightSidebar
