import { ArrowLeftRight } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '../store'
import { resolveWorkspaceMode, workspaceModeLayoutBundle } from './workspace-mode'
import { normalizeWorktreeChatSide } from '../store/slices/tabs/chat-panel-layout'

/**
 * Work/Code mode switch. Work keeps sessions left with chat center; Code keeps
 * Explorer left with editor center and chat right. Each switch restores its
 * fixed panel arrangement instead of just moving one sidebar.
 */
export function SidebarLayoutToggle(): React.JSX.Element {
  const mode = useAppStore((s) => resolveWorkspaceMode(s.settings))
  const updateSettings = useAppStore((s) => s.updateSettings)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)
  const setRightSidebarOpen = useAppStore((s) => s.setRightSidebarOpen)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)
  const isCode = mode === 'code'
  const label = isCode
    ? translate(
        'app.sidebarLayout.switchToWork',
        'Switch to Work mode (sessions left, chat center)'
      )
    : translate('app.sidebarLayout.switchToCode', 'Switch to Code mode (Explorer left, chat right)')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="sidebar-toggle"
          aria-label={label}
          aria-pressed={isCode}
          onClick={() => {
            const nextMode = isCode ? 'work' : 'code'
            const next = workspaceModeLayoutBundle(nextMode)
            setSidebarOpen(next.sidebarOpen)
            setRightSidebarTab(next.rightSidebarTab)
            setRightSidebarOpen(next.rightSidebarOpen)
            // Why: a mode switch reorders existing columns so Code keeps
            // editor center with chat right instead of leaving chat left.
            useAppStore.setState((state) => {
              let changed = false
              const layoutByWorktree = { ...state.layoutByWorktree }
              for (const worktreeId of Object.keys(layoutByWorktree)) {
                const normalized = normalizeWorktreeChatSide(
                  layoutByWorktree[worktreeId],
                  state.groupsByWorktree[worktreeId],
                  nextMode
                )
                if (normalized && normalized !== layoutByWorktree[worktreeId]) {
                  layoutByWorktree[worktreeId] = normalized
                  changed = true
                }
              }
              return changed ? { layoutByWorktree } : state
            })
            void updateSettings({
              workspaceMode: nextMode,
              toolsSidebarPosition: next.toolsSidebarPosition
            })
          }}
        >
          <ArrowLeftRight size={16} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
