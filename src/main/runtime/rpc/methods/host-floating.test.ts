import '../unused-default-rpc-methods.test-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { HOST_FLOATING_METHODS } from './host-floating'

const runtimeMocks = vi.hoisted(() => ({
  getRuntimeId: () => 'test-runtime',
  getFloatingTerminalCwd: vi.fn(),
  getFloatingMarkdownDirectory: vi.fn(),
  trustFloatingWorkspaceDirectory: vi.fn(),
  resolveFloatingMarkdownDocument: vi.fn()
}))

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function dispatch() {
  return new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the floating workspace surface is exercised by these dispatcher tests.
    runtime: runtimeMocks as unknown as OrcaRuntimeService,
    methods: HOST_FLOATING_METHODS
  })
}

describe('host floating RPC methods', () => {
  beforeEach(() => {
    runtimeMocks.getFloatingTerminalCwd.mockReset().mockResolvedValue('/home/kaylee')
    runtimeMocks.getFloatingMarkdownDirectory
      .mockReset()
      .mockResolvedValue('/home/kaylee/floating-workspace')
    runtimeMocks.trustFloatingWorkspaceDirectory.mockReset().mockResolvedValue(undefined)
    runtimeMocks.resolveFloatingMarkdownDocument.mockReset().mockReturnValue({
      filePath: '/home/kaylee/floating-workspace/note.md',
      relativePath: 'note.md',
      basename: 'note.md',
      name: 'note'
    })
  })

  it('resolves the floating terminal cwd through the runtime', async () => {
    await expect(
      dispatch().dispatch(makeRequest('host.floating.getTerminalCwd', { path: '~' }))
    ).resolves.toMatchObject({ ok: true, result: '/home/kaylee' })
    expect(runtimeMocks.getFloatingTerminalCwd).toHaveBeenCalledWith({ path: '~' })
  })

  it('resolves the floating markdown directory without params', async () => {
    await expect(
      dispatch().dispatch(makeRequest('host.floating.getMarkdownDirectory'))
    ).resolves.toMatchObject({ ok: true, result: '/home/kaylee/floating-workspace' })
  })

  it('trusts a picker-approved directory', async () => {
    await expect(
      dispatch().dispatch(
        makeRequest('host.floating.trustDirectory', { dirPath: '/home/kaylee/notes' })
      )
    ).resolves.toMatchObject({ ok: true })
    expect(runtimeMocks.trustFloatingWorkspaceDirectory).toHaveBeenCalledWith('/home/kaylee/notes')
  })

  it('resolves a picked markdown document', async () => {
    await expect(
      dispatch().dispatch(
        makeRequest('host.floating.resolveMarkdownDocument', {
          filePath: '/home/kaylee/floating-workspace/note.md',
          directory: '/home/kaylee/floating-workspace'
        })
      )
    ).resolves.toMatchObject({
      ok: true,
      result: { relativePath: 'note.md' }
    })
  })

  it('rejects invalid params without reaching the runtime', async () => {
    await expect(
      dispatch().dispatch(makeRequest('host.floating.getTerminalCwd', { path: 42 }))
    ).resolves.toMatchObject({ ok: false })
    await expect(
      dispatch().dispatch(makeRequest('host.floating.trustDirectory', {}))
    ).resolves.toMatchObject({ ok: false })
    expect(runtimeMocks.getFloatingTerminalCwd).not.toHaveBeenCalled()
    expect(runtimeMocks.trustFloatingWorkspaceDirectory).not.toHaveBeenCalled()
  })
})
