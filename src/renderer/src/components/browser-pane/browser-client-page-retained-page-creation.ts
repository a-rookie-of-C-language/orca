import type { BrowserClientPageRendererIdentity as RendererPageIdentity } from '../../../../shared/browser-client-page-renderer-protocol'
import {
  createBrowserClientPageRetainedHost,
  hideRetainedHostWhileGuestIsBlank,
  createBrowserClientPageWebview,
  type BrowserClientPageWebviewFactory
} from './browser-client-page-retained-elements'
import { enrolRetainedHostDragPassthrough } from './browser-client-page-visible-attachment'
import type { BrowserClientRetainedRendererPage as RetainedPage } from './browser-client-page-retained-state'

export function createBrowserClientPageRetainedPage(options: {
  document: Document
  identity: RendererPageIdentity
  key: string
  attachTimeoutMs: number
  createWebview?: BrowserClientPageWebviewFactory
  onAttached(page: RetainedPage): void
  onReady(page: RetainedPage): void
  onDestroyed(page: RetainedPage): void
  onRendererGone(page: RetainedPage): void
  onAttachmentTimeout(page: RetainedPage): void
  registerPage(page: RetainedPage): void
  incrementPartitionCount(partition: string): void
  appendHost(host: HTMLDivElement, webview: Electron.WebviewTag): void
  onWebviewMounted?(browserPageId: string): void
}): RetainedPage {
  const { identity } = options
  const host = createBrowserClientPageRetainedHost(options.document, identity.browserPageId)
  const webview = createBrowserClientPageWebview({
    createWebview: options.createWebview,
    document: options.document,
    browserPageId: identity.browserPageId,
    host,
    partition: identity.partition
  })

  let resolveMount!: RetainedPage['resolveMount']
  let rejectMount!: RetainedPage['rejectMount']
  const mount = new Promise<{ webContentsId: number }>((resolve, reject) => {
    resolveMount = resolve
    rejectMount = reject
  })
  let page: RetainedPage
  const onAttached = (): void => options.onAttached(page)
  const onReady = (): void => options.onReady(page)
  const onDestroyed = (): void => options.onDestroyed(page)
  const onRendererGone = (): void => options.onRendererGone(page)
  page = {
    key: options.key,
    identity,
    host,
    webview,
    status: 'attaching',
    webContentsId: null,
    metadataRevision: 0,
    attachmentObserved: false,
    visibleAttachment: null,
    mount,
    resolveMount,
    rejectMount,
    attachTimer: setTimeout(() => options.onAttachmentTimeout(page), options.attachTimeoutMs),
    onAttached,
    onReady,
    onDestroyed,
    onRendererGone,
    onLoadCommit: hideRetainedHostWhileGuestIsBlank(host),
    releaseDragPassthroughSurface: () => {}
  }
  page.releaseDragPassthroughSurface = enrolRetainedHostDragPassthrough(page)
  webview.addEventListener('did-attach', onAttached)
  webview.addEventListener('dom-ready', onReady)
  webview.addEventListener('destroyed', onDestroyed)
  webview.addEventListener('render-process-gone', onRendererGone)
  webview.addEventListener('load-commit', page.onLoadCommit)
  options.registerPage(page)
  options.incrementPartitionCount(identity.partition)
  options.appendHost(host, webview)
  options.onWebviewMounted?.(identity.browserPageId)
  return page
}
