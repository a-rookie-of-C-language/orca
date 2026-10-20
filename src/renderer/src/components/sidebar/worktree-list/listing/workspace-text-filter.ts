import type { Worktree } from '../../../../../../shared/worktree/types'

// Why 20: dsh caps a non-blank search at one flat page so one query
// never floods the sidebar; choosing a result clears the query anyway.
export const WORKSPACE_TEXT_SEARCH_LIMIT = 20

// Why shared frozen identity: the search-forced expansion below must never
// reallocate a set per render while the query is active.
export const EMPTY_COLLAPSED_GROUPS = new Set<string>()

// Why separate: the capped slice hides whether more rows matched, so the
// sidebar needs its own cheap count to decide if the limit hint should show.
export function didWorkspaceTextQueryHitLimit<
  T extends Pick<Worktree, 'displayName' | 'path' | 'branch' | 'repoId'>
>(
  worktrees: readonly T[],
  repoMap: ReadonlyMap<string, { displayName: string }>,
  query: string
): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return false
  }
  let matches = 0
  for (const worktree of worktrees) {
    if (matchesWorkspaceTextQuery(worktree, repoMap.get(worktree.repoId)?.displayName, query)) {
      matches += 1
      if (matches > WORKSPACE_TEXT_SEARCH_LIMIT) {
        return true
      }
    }
  }
  return false
}

// Why standalone: session-local text search must not touch the persisted
// filter store, so the matcher stays a pure function over rendered rows.
export function matchesWorkspaceTextQuery(
  worktree: Pick<Worktree, 'displayName' | 'path' | 'branch'>,
  repoDisplayName: string | undefined,
  query: string
): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return true
  }
  const haystacks = [worktree.displayName, worktree.path, worktree.branch, repoDisplayName ?? '']
  return haystacks.some((field) => field.toLowerCase().includes(needle))
}

export function filterWorktreesByTextQuery<
  T extends Pick<Worktree, 'displayName' | 'path' | 'branch' | 'repoId'>
>(
  worktrees: readonly T[],
  repoMap: ReadonlyMap<string, { displayName: string }>,
  query: string
): T[] {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return [...worktrees]
  }
  const out: T[] = []
  for (const worktree of worktrees) {
    if (!matchesWorkspaceTextQuery(worktree, repoMap.get(worktree.repoId)?.displayName, query)) {
      continue
    }
    out.push(worktree)
    if (out.length >= WORKSPACE_TEXT_SEARCH_LIMIT) {
      break
    }
  }
  return out
}
