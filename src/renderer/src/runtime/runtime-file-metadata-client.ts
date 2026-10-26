import type { MarkdownDocument } from '../../../shared/filesystem-entry-types'
import type { RuntimeFileOperationArgs } from './runtime-file-client-types'
import {
  assertLocalFilesystemFallbackAllowed,
  getRemoteFileArgs,
  getRemoteFileMutationArgs,
  withSshMutationExpectation
} from './runtime-file-routing'
import { callRuntimeRpc } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import type { LocalFileAccess } from '../../../shared/local-file-access'
import { localAccess } from './runtime-file-read-client'
import { isDirectSshFileContext, statDirectSshFile } from './runtime-direct-ssh-file-read'

export async function listRuntimeMarkdownDocuments(
  context: RuntimeFileOperationArgs,
  rootPath: string
): Promise<MarkdownDocument[]> {
  const target = context.target
  if (target.kind !== 'environment' || !context.worktreeId) {
    return window.api.fs.listMarkdownDocuments({
      rootPath,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<MarkdownDocument[]>(
    target,
    'files.listMarkdownDocuments',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId) },
    { timeoutMs: 15_000 }
  )
}

export async function statRuntimePath(
  context: RuntimeFileOperationArgs,
  absolutePath: string,
  access?: LocalFileAccess
): Promise<{ size: number; isDirectory: boolean; mtime: number }> {
  if (isDirectSshFileContext(context)) {
    return statDirectSshFile(context, absolutePath)
  }
  const remoteArgs = getRemoteFileArgs(context, absolutePath)
  if (!remoteArgs) {
    assertLocalFilesystemFallbackAllowed(context)
    return window.api.fs.stat({
      filePath: absolutePath,
      connectionId: context.connectionId,
      ...localAccess(context.connectionId, access)
    })
  }
  return callRuntimeRpc<{ size: number; isDirectory: boolean; mtime: number }>(
    remoteArgs.target,
    'files.stat',
    { worktree: remoteArgs.worktreeSelector, relativePath: remoteArgs.relativePath },
    { timeoutMs: 15_000 }
  )
}

export function isMissingRuntimePathError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return (
    message.includes('enoent') ||
    message.includes('not found') ||
    message.includes('no such file') ||
    // Old hosts’ full ENOTDIR errno means absence like ENOENT; do not mistake a filename beginning enotdir for an error.
    message.includes('enotdir: not a directory')
  )
}

export async function runtimePathExists(
  context: RuntimeFileOperationArgs,
  absolutePath: string,
  expectedEnvironmentPairingRevision?: number
): Promise<boolean> {
  // Direct SSH mutations use the local runtime's workspace authority. Do not
  // probe these paths through the file-read bridge: directories are not files.
  const remoteArgs = getRemoteFileMutationArgs(context, absolutePath)
  if (!remoteArgs) {
    if (isDirectSshFileContext(context)) {
      try {
        await statDirectSshFile(context, absolutePath)
        return true
      } catch (err) {
        if (isMissingRuntimePathError(err)) {
          return false
        }
        throw err
      }
    }
    assertLocalFilesystemFallbackAllowed(context)
    return window.api.fs.pathExists({
      filePath: absolutePath,
      connectionId: context.connectionId
    })
  }

  try {
    await callRuntimeRpc(
      remoteArgs.target,
      'files.stat',
      withSshMutationExpectation(context, {
        worktree: remoteArgs.worktreeSelector,
        relativePath: remoteArgs.relativePath
      }),
      { timeoutMs: 15_000, expectedEnvironmentPairingRevision }
    )
    return true
  } catch (err) {
    if (isMissingRuntimePathError(err)) {
      return false
    }
    throw err
  }
}
