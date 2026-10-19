import type { RemoteRuntimeInputEndpoint } from '../../components/terminal-pane/remote-runtime-recovery-input-hold'
import type { RemoteRuntimeMultiplexedTerminal } from '../../runtime/remote-runtime-terminal-multiplexer-types'
import type { TauriPtyInputSession } from './web-tauri-pty-input-session'

export type TauriPtyState = {
  id: string
  handle: string
  ptyId?: string
  worktreeId: string
  cwd: string
  size: { cols: number; rows: number }
  stream: RemoteRuntimeMultiplexedTerminal
  endpoint: RemoteRuntimeInputEndpoint
  inputSession: TauriPtyInputSession
}
