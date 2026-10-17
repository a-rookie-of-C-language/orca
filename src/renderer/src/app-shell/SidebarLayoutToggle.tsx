import { ArrowLeftRight } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '../store'
import { resolveWorkspaceMode, workspaceModeLayoutBundle } from './workspace-mode'

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
    ? translate('app.sidebarLayout.switchToWork', 'Switch to Work mode (sessions left, chat center)')
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
            const next = workspaceModeLayoutBundle(isCode ? 'work' : 'code')
            setSidebarOpen(next.sidebarOpen)
            setRightSidebarTab(next.rightSidebarTab)
            setRightSidebarOpen(next.rightSidebarOpen)
            void updateSettings({
              workspaceMode: isCode ? 'work' : 'code',
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
