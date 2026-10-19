import { describe, expect, it, vi } from 'vitest'
import { readRuntimeTerminalCwd, TERMINAL_CWD_METHOD } from './terminal-cwd-method'

function createHost() {
  return {
    resolveLiveLeafForHandle: vi.fn((_handle: string): { ptyId: string | null } | null => ({
      ptyId: 'pty-1'
    })),
    getPtyExecutionHostMetadata: vi.fn((_ptyId: string) => ({ incarnationId: 'inc-1' })),
    resolveTerminalCwd: vi.fn(async (_handle: string): Promise<string | null> => '/remote/repo/src')
  }
}

describe('terminal.cwd', () => {
  it('registers a read-only workspace method with the optional incarnation fence', () => {
    expect(TERMINAL_CWD_METHOD.name).toBe('terminal.cwd')
    expect(TERMINAL_CWD_METHOD.permission).toBe('workspace')
    expect(
      TERMINAL_CWD_METHOD.params.parse({ terminal: 'term-1', expectedIncarnationId: 'inc-1' })
    ).toEqual({ terminal: 'term-1', expectedIncarnationId: 'inc-1' })
  })

  it('reads cwd from the execution host without listing terminals or capturing buffers', async () => {
    const host = createHost()
    await expect(
      readRuntimeTerminalCwd(host, {
        terminal: 'term-1',
        expectedIncarnationId: 'inc-1'
      })
    ).resolves.toEqual({ cwd: '/remote/repo/src' })
    expect(host.resolveTerminalCwd).toHaveBeenCalledWith('term-1')
    expect(host.getPtyExecutionHostMetadata).toHaveBeenCalledWith('pty-1')
  })

  it('accepts older callers without an incarnation fence', async () => {
    await expect(readRuntimeTerminalCwd(createHost(), { terminal: 'term-1' })).resolves.toEqual({
      cwd: '/remote/repo/src'
    })
  })

  it('returns unknown when the handle has no PTY', async () => {
    const host = createHost()
    host.resolveLiveLeafForHandle.mockReturnValue(null)
    await expect(readRuntimeTerminalCwd(host, { terminal: 'term-1' })).resolves.toEqual({
      cwd: null
    })
    expect(host.resolveTerminalCwd).not.toHaveBeenCalled()
  })

  it('does not read the cwd of a different incarnation', async () => {
    const host = createHost()
    await expect(
      readRuntimeTerminalCwd(host, {
        terminal: 'term-1',
        expectedIncarnationId: 'old-incarnation'
      })
    ).rejects.toThrow('terminal_handle_stale')
    expect(host.resolveTerminalCwd).not.toHaveBeenCalled()
  })

  it('rejects a PTY replacement while the host reads the cwd', async () => {
    const host = createHost()
    host.resolveTerminalCwd.mockImplementationOnce(async () => {
      host.resolveLiveLeafForHandle.mockReturnValue({ ptyId: 'pty-2' })
      return '/old-process'
    })
    await expect(readRuntimeTerminalCwd(host, { terminal: 'term-1' })).rejects.toThrow(
      'terminal_handle_stale'
    )
  })

  it('rejects reuse of the same PTY id by a new incarnation', async () => {
    const host = createHost()
    host.resolveTerminalCwd.mockImplementationOnce(async () => {
      host.getPtyExecutionHostMetadata.mockReturnValue({ incarnationId: 'inc-2' })
      return '/old-process'
    })
    await expect(readRuntimeTerminalCwd(host, { terminal: 'term-1' })).rejects.toThrow(
      'terminal_handle_stale'
    )
  })

  it('preserves an unavailable cwd rather than fabricating a workspace directory', async () => {
    const host = createHost()
    host.resolveTerminalCwd.mockResolvedValue(null)
    await expect(readRuntimeTerminalCwd(host, { terminal: 'term-1' })).resolves.toEqual({
      cwd: null
    })
  })
})
