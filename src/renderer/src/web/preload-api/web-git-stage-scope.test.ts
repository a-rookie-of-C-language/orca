// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GIT_STAGE_WORKTREE_SCOPE_UNSUPPORTED_MESSAGE } from '../../../../shared/git-stage-worktree-scope'

const callRuntimeResult = vi.hoisted(() => vi.fn())

vi.mock('./web-runtime-calls', () => ({ callRuntimeResult }))
vi.mock('./web-runtime-worktree-catalog', () => ({
  resolveRuntimeWorktreeByPath: async () => ({ id: 'wt-1' }),
  resolveRuntimeFilePath: vi.fn()
}))

import { createGitApi } from './web-git-api'

describe('web client whole-worktree Stage All', () => {
  beforeEach(() => {
    callRuntimeResult.mockReset()
  })

  afterEach(() => {
    window.__TAURI_INTERNALS__ = undefined
  })

  it('sends the scope without paths and accepts the runtime receipt', async () => {
    callRuntimeResult.mockResolvedValue({ ok: true, stagedScope: 'all' })

    await createGitApi().bulkStage!({ worktreePath: '/repo', filePaths: ['a.ts'], scope: 'all' })

    expect(callRuntimeResult).toHaveBeenCalledWith('git.bulkStage', {
      worktree: 'id:wt-1',
      filePaths: [],
      scope: 'all'
    })
  })

  it('rejects an older runtime that staged nothing and sent no receipt', async () => {
    callRuntimeResult.mockResolvedValue({ ok: true })

    await expect(
      createGitApi().bulkStage!({ worktreePath: '/repo', filePaths: [], scope: 'all' })
    ).rejects.toThrow(GIT_STAGE_WORKTREE_SCOPE_UNSUPPORTED_MESSAGE)
  })

  it('routes local AI git generation through the paired runtime in Tauri', async () => {
    window.__TAURI_INTERNALS__ = { invoke: vi.fn() }
    callRuntimeResult.mockResolvedValue({ success: true, message: 'feat: update' })

    await createGitApi().generateCommitMessage!({ worktreePath: '/repo' })
    await createGitApi().discoverCommitMessageModels!({
      agentId: 'codex',
      worktreePath: '/repo'
    })
    await createGitApi().cancelGenerateCommitMessage!({ worktreePath: '/repo' })
    await createGitApi().generatePullRequestFields!({
      worktreePath: '/repo',
      base: 'main',
      title: 'Change title',
      body: 'Change body',
      draft: false
    })
    await createGitApi().cancelGeneratePullRequestFields!({ worktreePath: '/repo' })

    expect(callRuntimeResult.mock.calls).toEqual([
      ['git.generateCommitMessage', { worktree: 'id:wt-1' }],
      ['git.discoverCommitMessageModels', { worktree: 'id:wt-1', agentId: 'codex' }],
      ['git.cancelGenerateCommitMessage', { worktree: 'id:wt-1' }],
      [
        'git.generatePullRequestFields',
        {
          worktree: 'id:wt-1',
          base: 'main',
          title: 'Change title',
          body: 'Change body',
          draft: false
        }
      ],
      ['git.cancelGeneratePullRequestFields', { worktree: 'id:wt-1' }]
    ])
  })
})
