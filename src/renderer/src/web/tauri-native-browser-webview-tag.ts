import type { NativeBrowserPage } from './tauri-native-browser-webview'
import type { PageFindOptions } from './tauri-native-browser-webview-find'
import { runPageFind, stopPageFind } from './tauri-native-browser-webview-find'

export type WebviewTagHooks = {
  queueNavigation: (page: NativeBrowserPage, url: string) => void
  invokeCommand: <T>(
    page: NativeBrowserPage,
    command: string,
    args: Record<string, unknown>
  ) => Promise<T>
  closePage: (page: NativeBrowserPage) => void
  detachElement: () => void
}

function stableWebContentsId(browserPageId: string): number {
  let hash = 2166136261
  for (const character of browserPageId) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function asElectronWebview(element: HTMLDivElement): Electron.WebviewTag {
  // SAFETY: the browser pane only consumes this proxy's EventTarget and WebviewTag methods;
  // the actual page is hosted by Tauri's child webview managed by the native bridge.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the shared browser-pane proxy surface is consumed by this compatibility adapter.
  return element as unknown as Electron.WebviewTag
}

export function buildTauriBrowserWebviewTag(
  page: NativeBrowserPage,
  hooks: WebviewTagHooks
): Electron.WebviewTag {
  const { element, browserPageId } = page
  Object.defineProperties(element, {
    src: {
      configurable: true,
      get: () => page.url,
      set: (value: string) => hooks.queueNavigation(page, value)
    },
    getURL: { value: () => page.url },
    getTitle: { value: () => page.title },
    isLoading: { value: () => page.loading },
    canGoBack: { value: () => page.historyIndex > 0 },
    canGoForward: { value: () => page.historyIndex < page.history.length - 1 },
    getWebContentsId: { value: () => stableWebContentsId(browserPageId) },
    getZoomLevel: { value: () => page.zoomLevel },
    setZoomLevel: {
      value: (level: number) => {
        page.zoomLevel = level
        void hooks.invokeCommand(page, 'poc_browser_set_zoom', {
          browserPageId,
          scaleFactor: 1.2 ** level
        })
      }
    },
    loadURL: {
      value: (url: string) => {
        hooks.queueNavigation(page, url)
        return page.ready
      }
    },
    goBack: {
      value: () => void hooks.invokeCommand(page, 'poc_browser_go_back', { browserPageId })
    },
    goForward: {
      value: () => void hooks.invokeCommand(page, 'poc_browser_go_forward', { browserPageId })
    },
    reload: {
      value: () => void hooks.invokeCommand(page, 'poc_browser_reload', { browserPageId })
    },
    reloadIgnoringCache: {
      value: () => {
        // Page.reload with ignoreCache; fall back to a plain reload when CDP is unavailable.
        void hooks
          .invokeCommand(page, 'poc_browser_cdp', {
            browserPageId,
            method: 'Page.reload',
            params: { ignoreCache: true }
          })
          .catch(() => hooks.invokeCommand(page, 'poc_browser_reload', { browserPageId }))
      }
    },
    stop: {
      value: () => void hooks.invokeCommand(page, 'poc_browser_stop', { browserPageId })
    },
    focus: {
      value: () => void hooks.invokeCommand(page, 'poc_browser_focus', { browserPageId })
    },
    findInPage: {
      value: (text: string, options?: PageFindOptions) => runPageFind(page, text, options)
    },
    stopFindInPage: {
      value: (action?: string) => stopPageFind(page, action)
    },
    isDestroyed: { value: () => page.destroyed },
    remove: {
      value: () => {
        hooks.closePage(page)
        hooks.detachElement()
      }
    }
  })
  return asElectronWebview(element)
}
