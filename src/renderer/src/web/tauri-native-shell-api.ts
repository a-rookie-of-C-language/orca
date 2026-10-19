import type { PreloadApi } from '../../../preload/api-types'
import type {
  ShellOpenExternalEditorRequest,
  ShellOpenExternalEditorResult,
  ShellOpenLocalPathResult
} from '../../../shared/shell-open-types'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import type { SshExternalEditorAuthorityResult } from '../../../shared/ssh-types'
import { createShellApi } from './preload-api/web-shell-api'
import { callRuntimeResult } from './preload-api/web-runtime-calls'
import { getBrowserPlatform } from './preload-api/web-storage'
import { invokeNative, invokePlugin, isTauriNativeHost } from './tauri-native-host'

function assertExternalUrl(url: string): void {
  const protocol = new URL(url).protocol
  if (!['http:', 'https:', 'mailto:', 'tel:'].includes(protocol)) {
    throw new Error(`Opening ${protocol} URLs is not allowed by the Tauri bridge.`)
  }
}

function toPickedPaths(value: string | string[] | null): string[] {
  if (Array.isArray(value)) {
    return value
  }
  return value ? [value] : []
}

async function pickPaths(options: Record<string, unknown>): Promise<string[]> {
  const result = await invokePlugin<string | string[] | null>('dialog', 'open', { options })
  return toPickedPaths(result)
}

export function createTauriNativeShellApi(): NonNullable<Partial<PreloadApi>['shell']> | undefined {
  if (!isTauriNativeHost()) {
    return undefined
  }
  const fallback = createShellApi()
  const openPath = async (path: string): Promise<void> => {
    await invokePlugin('opener', 'open_path', { path, with: null })
  }
  const revealPath = async (path: string): Promise<ShellOpenLocalPathResult> => {
    try {
      await invokePlugin('opener', 'reveal_item_in_dir', { path })
      return { ok: true }
    } catch {
      return { ok: false, reason: 'launch-failed' }
    }
  }
  return {
    ...fallback,
    openPath: (path, _ownerHostId) => openPath(path),
    openInFileManager: (path, _ownerHostId) => revealPath(path),
    openInExternalEditor: async (
      request: ShellOpenExternalEditorRequest
    ): Promise<ShellOpenExternalEditorResult> => {
      try {
        const connectionId = request.connectionId?.trim()
        if (connectionId) {
          if (request.ownerHostId !== toSshExecutionHostId(connectionId)) {
            return { ok: false, reason: 'remote-runtime-unsupported' }
          }
          const authority = await callRuntimeResult<SshExternalEditorAuthorityResult>(
            'ssh.resolveExternalEditorAuthority',
            { targetId: connectionId }
          )
          if (!authority.ok) {
            return authority
          }
          return await invokeNative<ShellOpenExternalEditorResult>('poc_open_external_editor', {
            args: { ...request, sshAuthority: authority.authority }
          })
        }
        return await invokeNative<ShellOpenExternalEditorResult>('poc_open_external_editor', {
          args: request
        })
      } catch {
        return { ok: false, reason: 'launch-failed' }
      }
    },
    openUrl: async (url) => {
      assertExternalUrl(url)
      await invokePlugin('opener', 'open_url', { url, with: null })
    },
    openFilePath: async (path, _ownerHostId) => {
      try {
        await openPath(path)
        return true
      } catch {
        return false
      }
    },
    openFileUri: async (uri, _ownerHostId) => {
      const parsed = new URL(uri)
      if (parsed.protocol !== 'file:') {
        throw new Error(`Unsupported file URI protocol: ${parsed.protocol}`)
      }
      let path = decodeURIComponent(parsed.pathname)
      if (getBrowserPlatform() === 'win32' && /^\/[A-Za-z]:/.test(path)) {
        path = path.slice(1)
      }
      await openPath(path)
    },
    pathsExist: (paths) => invokeNative<boolean[]>('poc_paths_exist', { paths }),
    pathExists: (path) => invokeNative<boolean>('poc_path_exists', { path }),
    pickAttachment: async () =>
      (
        await pickPaths({
          title: 'Select attachment',
          multiple: false,
          directory: false
        })
      )[0] ?? null,
    pickAttachments: () =>
      pickPaths({ title: 'Select attachments', multiple: true, directory: false }),
    pickImage: async () =>
      (
        await pickPaths({
          title: 'Select image',
          multiple: false,
          directory: false,
          filters: [
            {
              name: 'Images',
              extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']
            }
          ]
        })
      )[0] ?? null,
    pickRepoIconImage: async () => {
      const filePath = (
        await pickPaths({
          title: 'Select repository icon',
          multiple: false,
          directory: false,
          filters: [{ name: 'PNG images', extensions: ['png'] }]
        })
      )[0]
      return filePath
        ? invokeNative<{ dataUrl: string; fileName: string }>('poc_read_file_data_url', {
            path: filePath
          })
        : null
    },
    pickAudio: async () =>
      (
        await pickPaths({
          title: 'Select audio',
          multiple: false,
          directory: false,
          filters: [{ name: 'Audio', extensions: ['ogg', 'mp3', 'wav', 'm4a', 'aac', 'flac'] }]
        })
      )[0] ?? null,
    pickDirectory: async ({ defaultPath }) =>
      (
        await pickPaths({
          title: 'Select directory',
          multiple: false,
          directory: true,
          ...(defaultPath ? { defaultPath } : {})
        })
      )[0] ?? null,
    copyFile: (args) => invokeNative('poc_copy_file', args)
  }
}
