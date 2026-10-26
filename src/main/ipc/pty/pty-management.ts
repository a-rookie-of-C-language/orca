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
} from '../../daemon/daemon-folder-access-mismatch'
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

// Match folder-access evidence against the current spawning daemon, never a legacy adapter.
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

  // Live terminals may outlast deleted AppImage runtime files; offer verified restart recovery.
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

  // The focus-time poll carries macOS attribution and folder-access evidence (STA-3491, STA-7948).
  ipcMain.handle(
    'pty:management:macTccAttribution',
    async (): Promise<{
      health: MacDaemonTccAttributionHealth
      folderAccessMismatch: DaemonFolderAccessMismatchNotice | null
    }> => {
      // Independent evidence reads must not erase folder-access state when health probing fails.
      const health = await getCurrentDaemonMacTccAttributionHealth().catch(
        (): MacDaemonTccAttributionHealth => 'unknown'
      )
      const identity = readCurrentDaemonIdentity()
      // Returning from System Settings is the opportunity to detect completed repair.
      await refreshDaemonFolderAccessProbe(identity).catch(() => {})
      return { health, folderAccessMismatch: getDaemonFolderAccessMismatch(identity) }
    }
  )

  // Clearing TCC state and prompting require an explicit user action; keep them out of polling.
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
