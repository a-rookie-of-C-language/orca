import type { PreloadApi } from '../../../preload/api-types'
import {
  assertClipboardTextWithinLimitWithYield,
  assertClipboardTextWriteWithinLimitWithYield,
  type ReadClipboardTextOptions
} from '../../../shared/clipboard-text'
import { uiZoomFactorFromLevel } from '../../../shared/ui-zoom-level'
import { invokeNative, invokePlugin, isTauriNativeHost, listenNative } from './tauri-native-host'

const EVENT_MAXIMIZE_CHANGED = 'window:maximize-changed'
const EVENT_FULLSCREEN_CHANGED = 'window:fullscreen-changed'
const EVENT_WINDOW_CLOSE_REQUESTED = 'window:close-requested'
const EVENT_TERMINAL_ZOOM = 'terminal:zoom'

export function createTauriNativeUiApi(): Partial<PreloadApi['ui']> {
  if (!isTauriNativeHost()) {
    return {}
  }
  let zoomLevel = 0
  return {
    readClipboardText: async (options?: ReadClipboardTextOptions) =>
      assertClipboardTextWithinLimitWithYield(
        await invokePlugin<string>('clipboard-manager', 'read_text'),
        options
      ),
    writeClipboardText: async (text) => {
      await assertClipboardTextWriteWithinLimitWithYield(text)
      await invokePlugin('clipboard-manager', 'write_text', { text, label: null })
    },
    writeTerminalClipboardText: async (text) => {
      await assertClipboardTextWriteWithinLimitWithYield(text)
      await invokePlugin('clipboard-manager', 'write_text', { text, label: null })
    },
    isMaximized: () => invokeNative<boolean>('poc_is_maximized'),
    minimize: () => {
      void invokeNative('poc_minimize').catch(() => {})
    },
    maximize: () => {
      void invokeNative('poc_toggle_maximize').catch(() => {})
    },
    onMaximizeChanged: (callback) => listenNative<boolean>(EVENT_MAXIMIZE_CHANGED, callback),
    onFullscreenChanged: (callback) =>
      listenNative<boolean>(EVENT_FULLSCREEN_CHANGED, callback),
    onWindowCloseRequested: (callback) =>
      listenNative<{ isQuitting: boolean; requestId?: number }>(
        EVENT_WINDOW_CLOSE_REQUESTED,
        (payload) => callback({ isQuitting: payload.isQuitting })
      ),
    requestClose: () => {
      void invokeNative('poc_request_close').catch(() => {})
    },
    confirmWindowClose: () => {
      void invokeNative('poc_confirm_close').catch(() => {})
    },
    onTerminalZoom: (callback) =>
      listenNative<'in' | 'out' | 'reset'>(EVENT_TERMINAL_ZOOM, callback),
    getZoomLevel: () => zoomLevel,
    setZoomLevel: (level) => {
      zoomLevel = level
      void invokeNative('poc_set_zoom', { scaleFactor: uiZoomFactorFromLevel(level) }).catch(
        () => {}
      )
    },
    popupMenu: () => {
      void invokeNative('poc_popup_menu').catch(() => {})
    },
    notifyWindowRevealed: () => {
      void invokeNative('poc_set_focus').catch(() => {})
    }
  }
}
