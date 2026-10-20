import { defineMethod } from '../core'
import {
  FloatingTerminalCwdRpcParams,
  ResolveFloatingMarkdownDocumentParams,
  TrustFloatingWorkspaceDirectoryParams
} from '../../../../shared/rpc-contract/floating-workspace-params'

// Why orcad: the Tauri shell owns the same local runtime as a paired desktop, so the
// floating terminal cwd, markdown directory and trust live here instead of Electron main.
export const HOST_FLOATING_METHODS = [
  defineMethod({
    name: 'host.floating.getTerminalCwd',
    permission: 'workspace',
    params: FloatingTerminalCwdRpcParams,
    handler: async (params, { runtime }) => runtime.getFloatingTerminalCwd(params)
  }),
  defineMethod({
    name: 'host.floating.getMarkdownDirectory',
    permission: 'workspace',
    params: null,
    handler: async (_params: void, { runtime }) => runtime.getFloatingMarkdownDirectory()
  }),
  defineMethod({
    name: 'host.floating.trustDirectory',
    permission: 'settings-write',
    params: TrustFloatingWorkspaceDirectoryParams,
    handler: async (params, { runtime }) => runtime.trustFloatingWorkspaceDirectory(params.dirPath)
  }),
  defineMethod({
    name: 'host.floating.resolveMarkdownDocument',
    permission: 'workspace',
    params: ResolveFloatingMarkdownDocumentParams,
    handler: async (params, { runtime }) =>
      runtime.resolveFloatingMarkdownDocument(params.filePath, params.directory)
  })
]
