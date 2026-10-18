import { useAppStore } from '@/store'
import { getAllWorktreesFromState } from '@/store/selectors'
import {
  buildWorkspaceRows,
  WorkspaceRowsSnapshotSchema,
  type WorkspaceRow
} from '../../../../shared/sidebar-list/workspace-rows'
import { defineSidebarShadowDomain } from './sidebar-shadow-comparison'

// Key order differs between a parsed reply and a built row; the values are what must agree.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : 1)))
      : entry
  )
}

/** Main's rows against the window's own catalog, built by the same shared projection. */
export const workspaceRowsShadow = defineSidebarShadowDomain<WorkspaceRow>({
  name: 'workspace-rows',
  readWindow: () => {
    const state = useAppStore.getState()
    const rows = buildWorkspaceRows({
      worktrees: getAllWorktreesFromState(state),
      folderWorkspaces: state.folderWorkspaces,
      repos: state.repos,
      lineageById: state.worktreeLineageById
    })
    // Parsed like main's reply, so both sides hold attachments in their normalized form.
    const parsed = WorkspaceRowsSnapshotSchema.parse({
      revision: 0,
      rows: Object.fromEntries(rows)
    })
    return new Map(Object.entries(parsed.rows))
  },
  readMain: async () => {
    const response = await window.api.runtime.call({ method: 'sidebarInputs.workspaceRows' })
    const parsed = response.ok ? WorkspaceRowsSnapshotSchema.safeParse(response.result) : null
    if (!parsed?.success) {
      return null
    }
    return { revision: parsed.data.revision, values: new Map(Object.entries(parsed.data.rows)) }
  },
  // The window has no terminal platform of its own to compare.
  equals: (window, main) => {
    if (!window || !main) {
      return window === main
    }
    const { terminalPlatform: _platform, ...mainRow } = main
    return canonical(window) === canonical(mainRow)
  }
})
