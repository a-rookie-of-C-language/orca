// User keybindings file access for the Tauri shell.
//
// Electron main owns `~/.orca/keybindings.json` through `KeybindingService`
// backed by node:fs. The renderer reuses the same fs-free document logic from
// `keybinding-document.ts` (shared with main) and performs the raw file IO
// through two dedicated native commands, so the Tauri shell reads and writes
// the same on-disk format Electron produces — one implementation, one schema.

import type { PreloadApi } from '../../../preload/api-types'
import {
  findKeybindingConflicts,
  formatKeybindingList,
  getKeybindingPlatform,
  isKeybindingActionId,
  type KeybindingFileDiagnostic,
  type KeybindingFileSnapshot,
  type KeybindingOverrides,
  type KeybindingPlatform
} from '../../../shared/keybindings'
import {
  createEmptyDocument,
  FILE_VERSION,
  isJsonObject,
  normalizeWriteBindingValue,
  parseBindingSection,
  parsePlatformOverrides,
  removeConflictingOverrides,
  type JsonObject
} from '../../../main/keybindings/keybinding-document'
import { invokeNative, invokePlugin, isTauriNativeHost } from './tauri-native-host'
import { getBrowserPlatform } from './preload-api/web-storage'

export type TauriKeybindingsApi = NonNullable<PreloadApi['keybindings']>

type NativeRead = { path: string; text?: string | null }

const tauriKeybindingListeners = new Set<(snapshot: KeybindingFileSnapshot) => void>()

function tauriPlatform(): KeybindingPlatform {
  return getKeybindingPlatform(getBrowserPlatform())
}

function readDocument(text: string | null | undefined): {
  exists: boolean
  document: JsonObject | null
  error?: string
} {
  if (text === null || text === undefined) {
    return { exists: false, document: createEmptyDocument() }
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (!isJsonObject(parsed)) {
      return { exists: true, document: null, error: 'Keybindings file must contain a JSON object.' }
    }
    return { exists: true, document: parsed }
  } catch (error) {
    return {
      exists: true,
      document: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function snapshotFromDocument(
  path: string,
  exists: boolean,
  document: JsonObject
): KeybindingFileSnapshot {
  const platform = tauriPlatform()
  const diagnostics: KeybindingFileDiagnostic[] = []
  const commonOverrides =
    document.keybindings === undefined
      ? parseBindingSection(document, 'root', diagnostics, { skipRootKeys: true })
      : parseBindingSection(document.keybindings, 'keybindings', diagnostics)
  const platformOverrides = parsePlatformOverrides(document, diagnostics)
  const overrides = removeConflictingOverrides(
    platform,
    { ...commonOverrides, ...platformOverrides[platform] },
    diagnostics
  )
  return { path, platform, exists, overrides, commonOverrides, platformOverrides, diagnostics }
}

async function readSnapshot(): Promise<KeybindingFileSnapshot> {
  const read = await invokeNative<NativeRead>('poc_read_keybindings_file')
  const parsed = readDocument(read.text)
  if (!parsed.document) {
    return {
      path: read.path,
      platform: tauriPlatform(),
      exists: parsed.exists,
      overrides: {},
      commonOverrides: {},
      platformOverrides: {},
      diagnostics: [
        {
          severity: 'error',
          message: `Could not read keybindings file: ${parsed.error ?? 'unknown error'}`
        }
      ]
    }
  }
  return snapshotFromDocument(read.path, parsed.exists, parsed.document)
}

async function writeDocument(document: JsonObject): Promise<void> {
  await invokeNative<NativeRead>('poc_write_keybindings_file', {
    text: `${JSON.stringify(document, null, 2)}\n`
  })
}

function notify(snapshot: KeybindingFileSnapshot): void {
  for (const listener of tauriKeybindingListeners) {
    listener(snapshot)
  }
}

// Why: mirrors Electron's `writeActivePlatformSection` — Settings writes and
// the legacy seed must produce the same on-disk shape, so one assembly path
// keeps them from drifting.
async function writeActivePlatformSection(
  fallbackCommonOverrides: KeybindingOverrides,
  mutateActivePlatform: (activePlatform: JsonObject) => void
): Promise<KeybindingFileSnapshot> {
  const platform = tauriPlatform()
  const read = await invokeNative<NativeRead>('poc_read_keybindings_file')
  const parsed = readDocument(read.text)
  if (!parsed.document) {
    // Why: writes must never replace a user-owned file that could not be
    // parsed; the caller surfaces the error after repair.
    throw new Error(parsed.error ?? 'Could not read keybindings file.')
  }
  const document = { ...parsed.document }
  const common = isJsonObject(document.keybindings)
    ? { ...document.keybindings }
    : { ...fallbackCommonOverrides }
  for (const rootKey of Object.keys(document)) {
    if (isKeybindingActionId(rootKey)) {
      delete document[rootKey]
    }
  }
  const platforms = isJsonObject(document.platforms) ? { ...document.platforms } : {}
  const activePlatform = isJsonObject(platforms[platform])
    ? { ...(platforms[platform] as JsonObject) }
    : {}
  mutateActivePlatform(activePlatform)

  document.version = FILE_VERSION
  document.keybindings = common
  document.platforms = {
    ...platforms,
    darwin: isJsonObject(platforms.darwin) ? platforms.darwin : {},
    linux: isJsonObject(platforms.linux) ? platforms.linux : {},
    win32: isJsonObject(platforms.win32) ? platforms.win32 : {},
    [platform]: activePlatform
  }
  await writeDocument(document)
  return readSnapshot()
}

async function writeKeybindingOverride(
  actionId: string,
  bindings: unknown
): Promise<KeybindingFileSnapshot> {
  if (!isKeybindingActionId(actionId)) {
    throw new Error(`Unknown keybinding action "${actionId}".`)
  }
  const normalizedBindings = normalizeWriteBindingValue(actionId, bindings)

  const platform = tauriPlatform()
  const currentSnapshot = await readSnapshot()
  const candidateOverrides = { ...currentSnapshot.overrides }
  if (normalizedBindings === null) {
    delete candidateOverrides[actionId]
  } else {
    candidateOverrides[actionId] = normalizedBindings
  }
  const blockingConflict = findKeybindingConflicts(platform, candidateOverrides).find((conflict) =>
    conflict.actionIds.includes(actionId)
  )
  if (blockingConflict) {
    throw new Error(
      `${formatKeybindingList([blockingConflict.binding], platform)} conflicts with another shortcut.`
    )
  }

  return writeActivePlatformSection(currentSnapshot.commonOverrides, (activePlatform) => {
    if (normalizedBindings === null) {
      // Why: Settings edits are scoped to the current platform. A hand-authored
      // common binding may be intentional for other OSes, so reset only removes
      // the platform-specific mask instead of deleting the shared value.
      delete activePlatform[actionId]
    } else {
      activePlatform[actionId] = normalizedBindings
    }
  })
}

async function ensureFile(): Promise<KeybindingFileSnapshot> {
  const snapshot = await readSnapshot()
  if (!snapshot.exists) {
    await writeDocument(createEmptyDocument())
    return readSnapshot()
  }
  return snapshot
}

export function createTauriNativeKeybindingsApi(): TauriKeybindingsApi | undefined {
  if (!isTauriNativeHost()) {
    return undefined
  }
  return {
    get: () => readSnapshot(),
    ensureFile: async () => {
      const snapshot = await ensureFile()
      notify(snapshot)
      return snapshot
    },
    setAction: async ({ actionId, bindings }) => {
      const snapshot = await writeKeybindingOverride(actionId, bindings)
      notify(snapshot)
      return snapshot
    },
    reload: async () => {
      const snapshot = await readSnapshot()
      notify(snapshot)
      return snapshot
    },
    openFile: async () => {
      const snapshot = await ensureFile()
      await invokePlugin('opener', 'open_path', { path: snapshot.path, with: null })
      return snapshot
    },
    revealFile: async () => {
      const snapshot = await ensureFile()
      await invokePlugin('opener', 'reveal_item_in_dir', { path: snapshot.path })
      return snapshot
    },
    onChanged: (callback) => {
      tauriKeybindingListeners.add(callback)
      return () => {
        tauriKeybindingListeners.delete(callback)
      }
    }
  }
}
