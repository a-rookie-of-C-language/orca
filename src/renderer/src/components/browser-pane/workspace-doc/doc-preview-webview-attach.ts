import { DOC_PREVIEW_PARTITION } from '../../../../../shared/doc-preview-scheme'
import { ORCA_BROWSER_PAGE_GUEST_WEB_PREFERENCES_ATTRIBUTE } from '../../../../../shared/browser-guest-web-preferences'
import {
  moveFocusToRendererBeforeWebviewDetach,
  registerPersistentWebview,
  unregisterPersistentWebview,
  webviewRegistry
} from '@/components/browser-pane/host-guest/webview-registry'
import { createTauriNativeBrowserWebview, isTauriNativeHost } from '@/web/tauri-native-bridge'

export function attachDocPreviewWebview({
  previewId,
  container,
  url,
  ariaLabel,
  onLoadStarted,
  onLoadStopped,
  onLoadFailed,
  onNavigated,
  onTitleUpdated,
  onViewportMessage
}: {
  previewId: string
  container: HTMLDivElement
  url: string
  ariaLabel: string
  onLoadStarted: () => void
  onLoadStopped: () => void
  onLoadFailed: (event: Electron.DidFailLoadEvent) => void
  onNavigated: () => void
  onTitleUpdated: (event: Electron.PageTitleUpdatedEvent) => void
  onViewportMessage: (event: { message?: string }) => void
}): { webview: Electron.WebviewTag; detach: () => void; reload: () => void } {
  const webview = isTauriNativeHost()
    ? createTauriNativeBrowserWebview({
        browserPageId: previewId,
        container,
        partition: DOC_PREVIEW_PARTITION,
        visible: true
      })
    : // SAFETY: Electron upgrades this custom element to WebviewTag at attach time.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the Electron custom element exposes WebviewTag methods after insertion.
      (document.createElement('webview') as Electron.WebviewTag)
  if (!isTauriNativeHost()) {
    // Why no allowpopups: the guest's preload intercepts a trusted click on a link before Chromium
    // considers a popup at all, so target="_blank" needs no popup path and every one stays denied.
    webview.setAttribute('partition', DOC_PREVIEW_PARTITION)
    webview.setAttribute('webpreferences', ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE)
  }
  webview.setAttribute('aria-label', ariaLabel)
  webview.style.display = 'flex'
  webview.style.width = '100%'
  webview.style.height = '100%'
  webview.style.border = 'none'
  webview.addEventListener('did-start-loading', onLoadStarted)
  webview.addEventListener('did-stop-loading', onLoadStopped)
  webview.addEventListener('did-fail-load', onLoadFailed)
  // Track both sibling-document navigation and fragment history for Back/Forward.
  webview.addEventListener('did-navigate', onNavigated)
  webview.addEventListener('did-navigate-in-page', onNavigated)
  // Let document titles name the tab while keeping the internal grant origin hidden.
  webview.addEventListener('page-title-updated', onTitleUpdated)
  webview.addEventListener('console-message', onViewportMessage)
  // Register before append so a guest attached mid-drag cannot swallow the pointer stream.
  registerPersistentWebview(previewId, webview)
  if (!isTauriNativeHost()) {
    container.appendChild(webview)
  }
  webview.setAttribute('src', url)

  return {
    webview,
    detach: () => {
      webview.removeEventListener('did-start-loading', onLoadStarted)
      webview.removeEventListener('did-stop-loading', onLoadStopped)
      webview.removeEventListener('did-fail-load', onLoadFailed)
      webview.removeEventListener('did-navigate', onNavigated)
      webview.removeEventListener('did-navigate-in-page', onNavigated)
      webview.removeEventListener('page-title-updated', onTitleUpdated)
      webview.removeEventListener('console-message', onViewportMessage)
      moveFocusToRendererBeforeWebviewDetach(webview)
      webview.remove()
      if (webviewRegistry.get(previewId) === webview) {
        unregisterPersistentWebview(previewId)
      }
    },
    // Why: the protocol handler answers with no-store, so a reload re-reads the workspace disk.
    reload: () => {
      try {
        webview.reload()
      } catch {
        webview.setAttribute('src', url)
      }
    }
  }
}
