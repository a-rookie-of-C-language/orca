// Tauri settings surfaces that Electron main owns: font enumeration runs in
// Rust (in-process GDI, cached), while the Ghostty and Warp theme-import
// previews reuse the shared parsers and mappers on the renderer so one
// implementation serves every host. Files the previews touch are read through
// the authorized-external staging boundary, matching the containment Electron
// applies implicitly as the main process.

import type { PreloadApi } from '../../../preload/api-types'
import { invokeNative, isTauriNativeHost } from './tauri-native-host'
import { previewTauriGhosttyImport } from './tauri-native-ghostty-import'
import { previewTauriWarpThemeImport } from './tauri-native-warp-theme-import'

export function createTauriNativeSettingsApi(): Partial<PreloadApi['settings']> | undefined {
  if (!isTauriNativeHost()) {
    return undefined
  }
  return {
    listFonts: () => invokeNative<string[]>('poc_list_system_fonts'),
    previewGhosttyImport: previewTauriGhosttyImport,
    previewWarpThemeImport: previewTauriWarpThemeImport
  }
}
