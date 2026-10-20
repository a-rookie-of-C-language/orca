import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

// Why: dsh session rows offer Copy Session ID with a global success toast;
// the sidebar agent rows mirror that contract. A clipboard failure toasts
// instead of rejecting: the row button stays put so the user can retry.
export async function copyAgentSessionId(sessionId: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(sessionId)
  } catch {
    toast.error(
      translate(
        'auto.components.dashboard.DashboardAgentRow.sessionIdCopyFailed',
        'Failed to copy Session ID. Try again.'
      )
    )
    return
  }
  toast.success(
    translate('auto.components.dashboard.DashboardAgentRow.sessionIdCopied', '{{value0}} copied', {
      value0: translate('auto.components.dashboard.DashboardAgentRow.sessionId', 'Session ID')
    })
  )
}
