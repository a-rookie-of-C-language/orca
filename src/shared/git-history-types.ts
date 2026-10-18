export type GitHistoryGraphColorId =
  | 'git-graph-ref'
  | 'git-graph-remote-ref'
  | 'git-graph-base-ref'
  | 'git-graph-lane-1'
  | 'git-graph-lane-2'
  | 'git-graph-lane-3'
  | 'git-graph-lane-4'
  | 'git-graph-lane-5'

export const GIT_HISTORY_REF_COLOR: GitHistoryGraphColorId = 'git-graph-ref'
export const GIT_HISTORY_REMOTE_REF_COLOR: GitHistoryGraphColorId = 'git-graph-remote-ref'
export const GIT_HISTORY_BASE_REF_COLOR: GitHistoryGraphColorId = 'git-graph-base-ref'

export const GIT_HISTORY_LANE_COLORS: readonly GitHistoryGraphColorId[] = [
  'git-graph-lane-1',
  'git-graph-lane-2',
  'git-graph-lane-3',
  'git-graph-lane-4',
  'git-graph-lane-5'
]

export const GIT_HISTORY_DEFAULT_LIMIT = 50
export const GIT_HISTORY_MAX_LIMIT = 200
export const GIT_HISTORY_MAX_REVISIONS = 10_000
// Recent fallback size for scope:'all' when a repo exceeds the safe limit.
export const GIT_HISTORY_RECENT_REF_COUNT = 200
// Hard ceiling for an explicit load-all; cursors above this are rejected.
export const GIT_HISTORY_HARD_REF_LIMIT = 100_000

export type GitHistoryScope = 'all' | 'current'

export type GitHistoryRefCategory = 'branches' | 'remote branches' | 'tags' | 'commits'

export type GitHistoryItemRef = {
  id: string
  name: string
  revision?: string
  category?: GitHistoryRefCategory
  description?: string
  color?: GitHistoryGraphColorId
}

export type GitHistoryItemStatistics = {
  files: number
  insertions: number
  deletions: number
}

export type GitHistoryItem = {
  id: string
  parentIds: string[]
  subject: string
  message: string
  displayId?: string
  author?: string
  authorEmail?: string
  /** Epoch milliseconds (git %at seconds × 1000). */
  timestamp?: number
  statistics?: GitHistoryItemStatistics
  references?: GitHistoryItemRef[]
}

export type GitHistoryOptions = {
  limit?: number
  baseRef?: string | null
  includeRelatedRefs?: boolean
  scope?: GitHistoryScope
  // User-confirmed slow path: include every branch tip instead of recent ones.
  forceAllRefs?: boolean
  cursor?: GitHistoryCursor
}

export type GitHistoryCursor = {
  revisions: string[]
  offset: number
  order?: 'date'
}

export type GitHistoryResult = {
  items: GitHistoryItem[]
  currentRef?: GitHistoryItemRef
  remoteRef?: GitHistoryItemRef
  baseRef?: GitHistoryItemRef
  mergeBase?: string
  hasIncomingChanges: boolean
  hasOutgoingChanges: boolean
  hasMore: boolean
  limit: number
  nextCursor?: GitHistoryCursor
  scope?: GitHistoryScope
  // Why: set when the repo has more branch refs than can be shown safely,
  // so the UI can explain the automatic fallback to recent branches.
  refLimitExceeded?: boolean
  // Total branch tips seen by the probe (capped at MAX_REVISIONS + 1).
  totalRefs?: number
  // Set when the user forced a full load of every branch tip.
  exhaustiveRefs?: boolean
}

export type GitHistoryExecutor = (
  args: string[],
  cwd: string,
  stdin?: string
) => Promise<{ stdout: string; stderr?: string }>
