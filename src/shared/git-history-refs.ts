import {
  GIT_HISTORY_HARD_REF_LIMIT,
  GIT_HISTORY_MAX_REVISIONS,
  GIT_HISTORY_RECENT_REF_COUNT,
  type GitHistoryExecutor
} from './git-history-types'

export type ResolvedHistoryRevisions = {
  revisions: string[]
  refLimitExceeded: boolean
  totalRefs?: number
  exhaustiveRefs?: boolean
}

function splitOids(stdout: string): string[] {
  return stdout.trim().split(/\r?\n/).filter(Boolean)
}

// Resolves which branch tips scope:'all' should feed into git log.
// Over-limit repos fall back to the most recently active tips unless the user forced a full load.
export async function resolveHistoryRevisions(
  git: GitHistoryExecutor,
  cwd: string,
  scope: 'all' | 'current' | undefined,
  forceAllRefs: boolean
): Promise<ResolvedHistoryRevisions> {
  if (scope !== 'all') {
    return { revisions: [], refLimitExceeded: false }
  }
  const { stdout } = await git(
    [
      'for-each-ref',
      `--count=${GIT_HISTORY_MAX_REVISIONS + 1}`,
      '--format=%(objectname)',
      'refs/heads/',
      'refs/remotes/'
    ],
    cwd
  )
  const probe = splitOids(stdout)
  if (probe.length <= GIT_HISTORY_MAX_REVISIONS) {
    return { revisions: probe, refLimitExceeded: false, totalRefs: probe.length }
  }
  if (!forceAllRefs) {
    const { stdout: recent } = await git(
      [
        'for-each-ref',
        '--sort=-committerdate',
        `--count=${GIT_HISTORY_RECENT_REF_COUNT}`,
        '--format=%(objectname)',
        'refs/heads/',
        'refs/remotes/'
      ],
      cwd
    )
    return { revisions: splitOids(recent), refLimitExceeded: true, totalRefs: probe.length }
  }
  const { stdout: full } = await git(
    ['for-each-ref', '--format=%(objectname)', 'refs/heads/', 'refs/remotes/'],
    cwd
  )
  const revisions = splitOids(full)
  if (revisions.length > GIT_HISTORY_HARD_REF_LIMIT) {
    throw new Error('Too many branch refs to display safely, even all at once.')
  }
  return { revisions, refLimitExceeded: false, totalRefs: revisions.length, exhaustiveRefs: true }
}
