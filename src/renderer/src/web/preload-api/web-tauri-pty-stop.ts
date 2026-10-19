import { callTauriPtyHost } from './web-tauri-pty-host'
import type { TauriPtyState } from './web-tauri-pty-state'

export async function stopTauriPtyOnHost(
  state: TauriPtyState,
  keepHistory: boolean
): Promise<void> {
  if (!keepHistory) {
    await callTauriPtyHost(state.id, 'terminal.close', { terminal: state.handle })
    return
  }
  if (!state.ptyId) {
    throw new Error('terminal_exact_stop_unavailable')
  }
  const result = await callTauriPtyHost<{
    stoppedPtyIds?: string[]
    livePtyIds?: string[]
    postStopVerified?: boolean
    postStopFailure?: string
  }>(state.id, 'terminal.stopExact', {
    worktree: state.worktreeId,
    expectedPtyIds: [state.ptyId],
    keepHistory: true,
    targetOnly: true
  })
  if (
    result.stoppedPtyIds?.length !== 1 ||
    result.stoppedPtyIds[0] !== state.ptyId ||
    !result.livePtyIds?.includes(state.ptyId)
  ) {
    throw new Error('exact_terminal_stop_mismatch')
  }
  if (result.postStopVerified !== true) {
    throw new Error(result.postStopFailure ?? 'exact_terminal_stop_unverified')
  }
}
