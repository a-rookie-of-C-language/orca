import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createAppStoreModuleMock,
  createDropdownMenuModuleMock,
  createProjectHeaderDragModuleMock,
  createReactVirtualModuleMock,
  createTooltipModuleMock,
  createVirtualizedScrollAnchorModuleMock,
  createWorktreeCardAgentsModuleMock,
  createWorktreeCardModuleMock,
  createWorktreeContextMenuModuleMock,
  createWorktreeTitleInlineRenameModuleMock,
  loadWorktreeList,
  mockStore,
  renderWorktreeListMarkup
} from './worktree-list-lineage-card-test-harness'
import { setLineageFixtureState } from './worktree-list-lineage-store-state'
import { makeWorktree } from './worktree-list-lineage-card-test-fixtures'

vi.mock('@/store', () => createAppStoreModuleMock())
vi.mock('@tanstack/react-virtual', () => createReactVirtualModuleMock())
vi.mock('@/hooks/useVirtualizedScrollAnchor', () => createVirtualizedScrollAnchorModuleMock())
vi.mock('./project-header-drag', () => createProjectHeaderDragModuleMock())
vi.mock('./WorktreeCard', () => createWorktreeCardModuleMock())
vi.mock('./WorktreeCardAgents', () => createWorktreeCardAgentsModuleMock())
vi.mock('./WorktreeTitleInlineRename', () => createWorktreeTitleInlineRenameModuleMock())
vi.mock('./WorktreeContextMenu', () => createWorktreeContextMenuModuleMock())
vi.mock('@/components/ui/tooltip', () => createTooltipModuleMock())
vi.mock('@/components/ui/dropdown-menu', () => createDropdownMenuModuleMock())

// Why: describe title is shared across the split files so test full names stay stable.
describe('WorktreeList lineage child card renderer', () => {
  beforeAll(async () => {
    await loadWorktreeList()
  }, 60_000)

  it('renders every worktree without a text query', async () => {
    setLineageFixtureState('none')
    const markup = await renderWorktreeListMarkup()

    expect(markup).toContain('data-worktree-card-id="parent"')
    expect(markup).toContain('data-worktree-card-id="child"')
    expect(markup).toContain('data-worktree-card-id="grandchild"')
  })

  it('keeps only the matching worktree for a text query', async () => {
    setLineageFixtureState('none')
    const markup = await renderWorktreeListMarkup({ textQuery: 'grandchild' })

    expect(markup).toContain('data-worktree-card-id="grandchild"')
    expect(markup).not.toContain('data-worktree-card-id="parent"')
    expect(markup).not.toContain('data-worktree-card-id="child"')
  })

  it('shows the empty state when no worktree matches', async () => {
    setLineageFixtureState('none')
    const markup = await renderWorktreeListMarkup({ textQuery: 'zzz-no-such-workspace' })

    expect(markup).toContain('No workspaces found')
    expect(markup).toContain('sidebar-empty-state-glyph')
  })

  it('forces collapsed groups open while a text query is active', async () => {
    setLineageFixtureState('repo', { projectGrouped: true })
    mockStore.state.collapsedGroups = new Set(['project-group:project-group-1'])

    const collapsed = await renderWorktreeListMarkup()
    expect(collapsed).not.toContain('data-worktree-card-id="grandchild"')

    const searched = await renderWorktreeListMarkup({ textQuery: 'grandchild' })
    expect(searched).toContain('data-worktree-card-id="grandchild"')
  })

  it('hides the limit hint when matches fit on one page', async () => {
    setLineageFixtureState('none')
    const markup = await renderWorktreeListMarkup({ textQuery: 'lineage' })

    expect(markup).not.toContain('workspace-search-limit-hint')
  })

  it('shows the limit hint when matches overflow one page', async () => {
    setLineageFixtureState('none')
    // Narrow unknown through `in` + Array.isArray so no assertion is needed.
    const repos = mockStore.state['worktreesByRepo']
    if (repos && typeof repos === 'object' && 'repo-1' in repos) {
      const overflowTarget = repos['repo-1']
      if (Array.isArray(overflowTarget)) {
        for (let index = 0; index < 25; index += 1) {
          overflowTarget.push(
            makeWorktree({
              id: `overflow-${index}`,
              instanceId: `overflow-instance-${index}`,
              displayName: `lineage overflow ${index}`,
              branch: 'overflow-branch',
              sortOrder: 100 + index
            })
          )
        }
      }
    }
    const markup = await renderWorktreeListMarkup({ textQuery: 'lineage overflow' })

    expect(markup).toContain('workspace-search-limit-hint')
    expect(markup).toContain('first 20 matches')
  })
})
