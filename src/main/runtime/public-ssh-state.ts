import type { SshConnectionState } from '../../shared/ssh-types'
import { getSshHostServerStatus } from '../ssh/ssh-host-server-status'

export function getPublicSshError(status: SshConnectionState['status']): string {
  return status === 'auth-failed' ? 'SSH authentication failed' : 'SSH connection unavailable'
}

export function getPublicSshState(state: SshConnectionState | null): SshConnectionState | null {
  if (!state) {
    return null
  }
  const managedServer = state.managedServer ?? getSshHostServerStatus(state.targetId)
  return {
    ...state,
    error: state.error ? getPublicSshError(state.status) : null,
    ...(managedServer ? { managedServer } : {})
  }
}
