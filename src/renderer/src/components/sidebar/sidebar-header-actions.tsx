import React, { useCallback } from 'react'
import { FolderPlus, PanelLeftClose, Plus, Search } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatOptionalPrimaryShortcutLabel } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { openWorkspaceCreationComposerWithTourHandoff } from '../contextual-tours/workspace-creation-tour-handoff'
import SidebarWorkspaceOptionsMenu from './SidebarWorkspaceOptionsMenu'

function AddProjectButton({
  preserveWorkspaceBoardOpen
}: {
  preserveWorkspaceBoardOpen: boolean
}): React.JSX.Element {
  const openModal = useAppStore((s) => s.openModal)
  const label = translate('auto.components.sidebar.SidebarHeader.addProject', 'Add project')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          className="text-muted-foreground"
          aria-label={label}
          data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
          onClick={() => openModal('add-repo')}
        >
          <FolderPlus className="size-3.5" strokeWidth={2.25} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function NewWorkspaceButton({
  preserveWorkspaceBoardOpen
}: {
  preserveWorkspaceBoardOpen: boolean
}): React.JSX.Element {
  const keybindings = useAppStore((s) => s.keybindings)
  // Why primary: workspace.create binds both Mod+N and Mod+Shift+N, and listing
  // every alias in a one-line tooltip reads as noise rather than help.
  const shortcutLabel = formatOptionalPrimaryShortcutLabel('workspace.create', keybindings)
  const label = translate('auto.components.sidebar.SidebarHeader.92154beb7e', 'New workspace')

  // Why the tour handoff here: the tour highlights this button, and it is now
  // the control that performs the action rather than one that opens a menu.
  const handleCreateWorkspace = useCallback(() => {
    openWorkspaceCreationComposerWithTourHandoff()
  }, [])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          className="text-muted-foreground"
          aria-label={label}
          data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
          data-contextual-tour-target="workspace-create-control"
          onClick={handleCreateWorkspace}
        >
          <Plus className="size-3.5" strokeWidth={2.25} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
        {shortcutLabel ? <span className="ml-1.5 text-background/60">{shortcutLabel}</span> : null}
      </TooltipContent>
    </Tooltip>
  )
}

export function SidebarHeaderActions({
  onWorkspaceBoardMenuOpenChange,
  agentsViewActive = false,
  onCollapseSidebar,
  showWorkspaceSearch = false,
  workspaceSearchOpen = false,
  onToggleWorkspaceSearch
}: {
  onWorkspaceBoardMenuOpenChange: (open: boolean) => void
  agentsViewActive?: boolean
  /** Work mode only; absent in Code mode so the rail never appears there. */
  onCollapseSidebar?: () => void
  /** dsh-style collapsed search; only offered on the Work workspaces view. */
  showWorkspaceSearch?: boolean
  workspaceSearchOpen?: boolean
  onToggleWorkspaceSearch?: () => void
}): React.JSX.Element {
  const keybindings = useAppStore((s) => s.keybindings)
  // Why primary: Toggle Sidebar binds one default (Mod+B); when the user
  // unbinds it the tooltip falls back to the bare label like dsh does.
  const toggleSidebarShortcut = formatOptionalPrimaryShortcutLabel(
    'sidebar.left.toggle',
    keybindings
  )
  const collapseLabel = translate(
    'auto.components.sidebar.SidebarHeaderActions.collapseSidebar',
    'Collapse sidebar'
  )
  return (
    <div className="flex shrink-0 items-center gap-1" data-sidebar-header-actions="">
      {onCollapseSidebar ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              className="text-muted-foreground"
              aria-label={collapseLabel}
              aria-keyshortcuts={toggleSidebarShortcut ?? undefined}
              aria-expanded={true}
              onClick={onCollapseSidebar}
            >
              <PanelLeftClose className="size-3.5" strokeWidth={2.25} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {collapseLabel}
            {toggleSidebarShortcut ? (
              <span className="ml-1.5 text-background/60">{toggleSidebarShortcut}</span>
            ) : null}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {showWorkspaceSearch && !agentsViewActive ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              className="text-muted-foreground"
              aria-label={translate(
                'auto.components.sidebar.SidebarHeaderActions.searchWorkspaces',
                'Search workspaces'
              )}
              aria-expanded={workspaceSearchOpen}
              aria-pressed={workspaceSearchOpen}
              onClick={onToggleWorkspaceSearch}
            >
              <Search className="size-3.5" strokeWidth={2.25} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate(
              'auto.components.sidebar.SidebarHeaderActions.searchWorkspaces',
              'Search workspaces'
            )}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {/* Why only options swap: the activity view portals its own options button into this slot
          (SidebarHeader), and keeping Add project means no header button shifts between views. */}
      {agentsViewActive ? null : (
        <SidebarWorkspaceOptionsMenu
          preserveWorkspaceBoardOpen
          onMenuOpenChange={onWorkspaceBoardMenuOpenChange}
        />
      )}
      <AddProjectButton preserveWorkspaceBoardOpen />
      <NewWorkspaceButton preserveWorkspaceBoardOpen />
    </div>
  )
}
