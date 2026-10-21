import type { SshConnectionStatus } from '../../../../shared/ssh-types'

// Why: a generated ~/.ssh/config can import >10k hosts; a row each made one open cost GBs of DOM.
export const SSH_STATUS_MENU_IDLE_ROW_LIMIT = 25
export const SSH_HOST_FIND_RESULT_LIMIT = 50

export type SshStatusMenuTarget = { id: string; label: string; status: SshConnectionStatus }

export type SshStatusMenuRows = {
  connected: SshStatusMenuTarget[]
  inactive: SshStatusMenuTarget[]
  /** Idle hosts the limit left out; the menu offers a search for them. */
  hiddenIdleCount: number
}

/**
 * Connected and busy hosts always get a row. Under the idle limit the rest keep config order; past
 * it, hosts that own projects fill the limit first so it keeps the machines the user works on.
 */
export function splitSshStatusMenuRows(
  targets: readonly SshStatusMenuTarget[],
  options: { projectHostIds?: ReadonlySet<string>; idleRowLimit?: number } = {}
): SshStatusMenuRows {
  const { projectHostIds, idleRowLimit = SSH_STATUS_MENU_IDLE_ROW_LIMIT } = options
  const connected = targets.filter((target) => target.status === 'connected')
  const inactive = targets.filter((target) => target.status !== 'connected')
  const idle = inactive.filter((target) => target.status === 'disconnected')
  if (idle.length <= idleRowLimit) {
    return { connected, inactive, hiddenIdleCount: 0 }
  }
  const busy = inactive.filter((target) => target.status !== 'disconnected')
  const shownIdle = [
    ...idle.filter((target) => projectHostIds?.has(target.id)),
    ...idle.filter((target) => !projectHostIds?.has(target.id))
  ].slice(0, idleRowLimit)
  return {
    connected,
    inactive: [...busy, ...shownIdle],
    hiddenIdleCount: idle.length - shownIdle.length
  }
}

/**
 * Not-connected hosts matching `query`, exact names first, then prefixes, then substrings, so any
 * host is reachable by typing its full name however many others share its prefix.
 */
export function findSshHostMatches(
  targets: readonly SshStatusMenuTarget[],
  query: string,
  limit = SSH_HOST_FIND_RESULT_LIMIT
): { matches: SshStatusMenuTarget[]; moreCount: number } {
  const needle = query.trim().toLowerCase()
  const exact: SshStatusMenuTarget[] = []
  const prefix: SshStatusMenuTarget[] = []
  const contains: SshStatusMenuTarget[] = []
  for (const target of targets) {
    if (target.status === 'connected') {
      continue
    }
    const label = target.label.toLowerCase()
    if (label === needle) {
      exact.push(target)
    } else if (label.startsWith(needle)) {
      prefix.push(target)
    } else if (label.includes(needle)) {
      contains.push(target)
    }
  }
  const all = [...exact, ...prefix, ...contains]
  return { matches: all.slice(0, limit), moreCount: Math.max(0, all.length - limit) }
}
