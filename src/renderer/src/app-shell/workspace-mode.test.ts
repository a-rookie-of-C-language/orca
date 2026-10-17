import { describe, expect, it } from 'vitest'
import { resolveWorkspaceMode, workspaceModeLayoutBundle } from './workspace-mode'

describe('resolveWorkspaceMode', () => {
  it('defaults older settings without a mode to Work', () => {
    expect(resolveWorkspaceMode(undefined)).toBe('work')
    expect(resolveWorkspaceMode(null)).toBe('work')
    expect(resolveWorkspaceMode({})).toBe('work')
    expect(resolveWorkspaceMode({ toolsSidebarPosition: 'left' })).toBe('work')
  })

  it('keeps an explicit mode', () => {
    expect(resolveWorkspaceMode({ workspaceMode: 'code' })).toBe('code')
    expect(resolveWorkspaceMode({ workspaceMode: 'work' })).toBe('work')
  })
})

describe('workspaceModeLayoutBundle', () => {
  it('fixes Work to sessions left with chat center', () => {
    expect(workspaceModeLayoutBundle('work')).toEqual({
      toolsSidebarPosition: 'right',
      sidebarOpen: true,
      rightSidebarOpen: false,
      rightSidebarTab: 'explorer'
    })
  })

  it('fixes Code to Explorer left with chat right', () => {
    expect(workspaceModeLayoutBundle('code')).toEqual({
      toolsSidebarPosition: 'left',
      sidebarOpen: false,
      rightSidebarOpen: true,
      rightSidebarTab: 'explorer'
    })
  })
})
