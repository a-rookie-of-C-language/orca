import { ORCA_BROWSER_BLANK_URL } from '../../../../../shared/constants'
import { ORCA_BROWSER_PAGE_GUEST_WEB_PREFERENCES_ATTRIBUTE } from '../../../../../shared/browser-guest-web-preferences'
import {
  destroyPersistentWebview,
  registerPersistentWebview,
  replacePersistentWebview,
  webviewRegistry
} from './webview-registry'
import {
  createTauriNativeBrowserWebview,
  isTauriNativeHost
} from '../../../web/tauri-native-bridge'

export function setBrowserPageWebviewInputLock(
  webview: Electron.WebviewTag,
  inputLocked: boolean
): void {
  webview.style.pointerEvents = inputLocked ? 'none' : 'auto'
}

export function ensureBrowserPageWebview({
  browserTabId,
  container,
  inputLocked,
  webviewPartition,
  resolveContainer
}: {
  browserTabId: string
  container: HTMLDivElement
  inputLocked: boolean
  webviewPartition: string
  resolveContainer: () => HTMLDivElement | null
}): { container: HTMLDivElement; created: boolean; webview: Electron.WebviewTag } | null {
  let webview = webviewRegistry.get(browserTabId)
  let created = false
  let activeContainer = container
  const parentDrifted = webview?.parentElement !== container

  // Rebuild after parent drift or partition changes: reparenting can recreate the guest and Electron partitions are immutable. Preserve a replacement viewport during parent repair.
  if (webview && (parentDrifted || webview.getAttribute('partition') !== webviewPartition)) {
    if (parentDrifted) {
      void replacePersistentWebview(browserTabId, { preserveViewport: true })
    } else {
      void destroyPersistentWebview(browserTabId)
    }
    webview = undefined
    const refreshedContainer = resolveContainer()
    if (!refreshedContainer) {
      return null
    }
    activeContainer = refreshedContainer
  }
  if (webview) {
    setBrowserPageWebviewInputLock(webview, inputLocked)
    return { container: activeContainer, created, webview }
  }

  if (isTauriNativeHost()) {
    webview = createTauriNativeBrowserWebview({
      browserPageId: browserTabId,
      container: activeContainer,
      partition: webviewPartition,
      visible: true
    })
  } else {
    webview = document.createElement('webview') as Electron.WebviewTag
    webview.setAttribute('partition', webviewPartition)
    webview.setAttribute('allowpopups', '')
    // Why: Electron spreads the webpreferences keys verbatim, so the shared
    // camelCase attribute must stay intact for fullscreen containment to work.
    // Keep Chromium's normal page canvas opaque while the host underneath follows Orca's theme.
    webview.setAttribute('webpreferences', ORCA_BROWSER_PAGE_GUEST_WEB_PREFERENCES_ATTRIBUTE)
    webview.style.display = 'flex'
    webview.style.flex = '1'
    webview.style.width = '100%'
    webview.style.height = '100%'
    webview.style.border = 'none'
    activeContainer.appendChild(webview)
  }
  setBrowserPageWebviewInputLock(webview, inputLocked)
  webview.style.background = 'var(--background)'
  const guest = webview
  // A committed synthetic blank document belongs to New Tab, including while its first URL waits.
  guest.addEventListener('load-commit', (event) => {
    if (event.isMainFrame) {
      guest.style.visibility =
        event.url === 'about:blank' || event.url === ORCA_BROWSER_BLANK_URL ? 'hidden' : 'visible'
    }
  })
  guest.addEventListener('render-process-gone', () => {
    guest.style.visibility = 'hidden'
  })
  guest.addEventListener('ipc-message', (event) => {
    handleGuestWindowCloseMessage(browserTabId, guest, event)
  })
  registerPersistentWebview(browserTabId, webview)
  created = true

  return { container: activeContainer, created, webview }
}
