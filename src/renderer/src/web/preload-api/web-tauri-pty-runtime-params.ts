import type { PreloadApi } from '../../../../preload/api-types'

export type TauriPtySpawnOptions = Parameters<NonNullable<PreloadApi['pty']>['spawn']>[0]

export function tauriPtyRuntimeCreateParams(opts: TauriPtySpawnOptions): Record<string, unknown> {
  return {
    // `terminal.create` calls this field a worktree selector. A cwd is a valid
    // selector for the same host and keeps standalone PTY callers useful.
    worktree: opts.worktreeId ?? opts.cwd,
    cwd: opts.cwd,
    cols: opts.cols,
    rows: opts.rows,
    command: opts.command,
    env: opts.env,
    envToDelete: opts.envToDelete,
    launchConfig: opts.launchConfig,
    resumeProviderSession: opts.resumeProviderSession,
    launchToken: opts.launchToken,
    launchAgent: opts.launchAgent,
    startupCommandDelivery: opts.startupCommandDelivery,
    shell: opts.shellOverride,
    terminalKittyKeyboardProtocol: opts.terminalKittyKeyboardProtocol,
    terminalColorQueryReplies: opts.terminalColorQueryReplies,
    tabId: opts.tabId,
    leafId: opts.leafId,
    presentation: opts.initiallyHidden ? 'background' : 'focused',
    activate: !opts.initiallyHidden,
    spawnIntent: opts.spawnIntent
  }
}
