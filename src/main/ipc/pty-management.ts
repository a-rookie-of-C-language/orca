import { ipcMain } from 'electron'
import {
  getCurrentDaemonMacTccAttributionHealth,
  getDaemonProvider
} from '../daemon/daemon-provider-state'
import {
  readSeveredDaemonStatus,
  restartSeveredDaemon,
  type SeveredDaemonIncarnation,
  type SeveredDaemonRestartResult
} from '../daemon/daemon-host-image-state'
import {
  getDaemonFolderAccessMismatch,
  refreshDaemonFolderAccessProbe,
  type DaemonFolderAccessMismatchNotice
} from '../daemon/daemon-folder-access-mismatch'
import {
  resetFolderAccessForDaemon,
  type DaemonFolderAccessResetResult
} from '../daemon/daemon-folder-access-reset'
import type { MacDaemonTccAttributionHealth } from '../daemon/daemon-tcc-attribution'
import type { DaemonEndpointIdentity } from '../daemon/daemon-hello-protocol'
import {
  killAllDaemonSessions,
  killDaemonSession,
  listDaemonSessions,
  readDaemonAsyncIoHealth,
  restartManagedDaemon
} from '../daemon/daemon-management'
import { getCurrentDaemonAdapter } from '../daemon/daemon-provider-routing'

// Why the current adapter only: evidence is keyed to the daemon now spawning terminals, so a
// legacy adapter's daemon must never satisfy the identity match that keeps the notice up.
function readCurrentDaemonIdentity(): DaemonEndpointIdentity | null {
  const provider = getDaemonProvider()
  return provider ? getCurrentDaemonAdapter(provider).getDaemonIdentity() : null
}

export function registerDaemonManagementHandlers(): void {
  ipcMain.removeHandler('pty:management:listSessions')
  ipcMain.removeHandler('pty:management:killAll')
  ipcMain.removeHandler('pty:management:killOne')
  ipcMain.removeHandler('pty:management:restart')
  ipcMain.removeHandler('pty:management:macTccAttribution')
  ipcMain.removeHandler('pty:management:resetFolderAccess')
  ipcMain.removeHandler('pty:management:severedDaemon')
  ipcMain.removeHandler('pty:management:restartSeveredDaemon')
  ipcMain.removeHandler('pty:management:asyncIoHealth')

  ipcMain.handle('pty:management:asyncIoHealth', async () => readDaemonAsyncIoHealth())

  // Why: a Linux AppImage daemon kept for its live terminals after its files vanished; the
  // banner polls this and offers the verified restart below.
  ipcMain.handle('pty:management:severedDaemon', async () => ({
    severed: await readSeveredDaemonStatus().catch(() => null)
  }))
  ipcMain.handle(
    'pty:management:restartSeveredDaemon',
    async (_event, args: unknown): Promise<SeveredDaemonRestartResult> => {
      const expected = parseSeveredDaemonIncarnation(args)
      if (!expected) {
        return { status: 'refused', reason: 'unverifiable' }
      }
      return restartSeveredDaemon(expected)
    }
  )

  // Why: lets Settings warn that macOS privacy grants no longer reach daemon terminals (STA-3491),
  // and carries the folder-access evidence the notice needs (STA-7948) on the same focus-time poll.
  ipcMain.handle(
    'pty:management:macTccAttribution',
    async (): Promise<{
      health: MacDaemonTccAttributionHealth
      folderAccessMismatch: DaemonFolderAccessMismatchNotice | null
    }> => {
      // Why two guards: the two answers are independent evidence, and a failed health read must
      // not present as "the folder evidence is gone".
      const health = await getCurrentDaemonMacTccAttributionHealth().catch(
        (): MacDaemonTccAttributionHealth => 'unknown'
      )
      const identity = readCurrentDaemonIdentity()
      // Why re-probe on the poll: the fix dialog's first step completes in System Settings, and
      // returning to Orca is the only moment anything can notice. The refresh owns when to skip.
      await refreshDaemonFolderAccessProbe(identity).catch(() => {})
      return { health, folderAccessMismatch: getDaemonFolderAccessMismatch(identity) }
    }
  )

  // Why a separate channel from the poll: this one has a side effect — it clears Orca's TCC row and
  // makes the app touch the folder so macOS re-prompts — and only a user click may trigger it.
  ipcMain.handle(
    'pty:management:resetFolderAccess',
    async (): Promise<DaemonFolderAccessResetResult> => {
      try {
        return await resetFolderAccessForDaemon(readCurrentDaemonIdentity())
      } catch {
        return { outcome: 'unsupported' }
      }
    }
  )

  ipcMain.handle('pty:management:listSessions', async () => listDaemonSessions())

  // Why: tears down sessions across all adapters (current + legacy); daemon processes survive. See docs/daemon-staleness-ux.md §Phase 1.
  ipcMain.handle('pty:management:killAll', async () => killAllDaemonSessions())

  ipcMain.handle('pty:management:killOne', async (_event, args: { sessionId: string }) =>
    killDaemonSession(args?.sessionId ?? '')
  )

  ipcMain.handle('pty:management:restart', async () => restartManagedDaemon())
}

function parseSeveredDaemonIncarnation(args: unknown): SeveredDaemonIncarnation | null {
  if (
    typeof args !== 'object' ||
    args === null ||
    !('pid' in args) ||
    !('linuxStartTicks' in args) ||
    !('bootId' in args)
  ) {
    return null
  }
  const { pid, linuxStartTicks, bootId } = args
  return typeof pid === 'number' &&
    Number.isSafeInteger(pid) &&
    pid > 0 &&
    typeof linuxStartTicks === 'string' &&
    typeof bootId === 'string'
    ? { pid, linuxStartTicks, bootId }
    : null
}
