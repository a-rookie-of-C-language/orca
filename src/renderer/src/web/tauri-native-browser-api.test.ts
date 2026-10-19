// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTauriNativeBrowserApi } from './tauri-native-browser-api'
import {
  createTauriNativeBrowserWebview,
  removeTauriNativeBrowserPage
} from './tauri-native-browser-webview'

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  pageEventHandlers: [] as ((event: unknown) => void)[]
}))
vi.mock('./tauri-native-host', () => ({
  isTauriNativeHost: () => true,
  invokeNative: native.invoke,
  listenNative: (channel: string, handler: (event: unknown) => void) => {
    if (channel === 'browser:page-event') {
      native.pageEventHandlers.push(handler)
    }
    return () => {}
  }
}))

type NavigationUpdate = { browserPageId: string; url: string; title: string }

function collectNavigationUpdates() {
  const api = createTauriNativeBrowserApi()
  const seen: NavigationUpdate[] = []
  api.onNavigationUpdate?.((event) => {
    seen.push(event)
  })
  return seen
}

function emitPageEvent(payload: Record<string, unknown>) {
  expect(native.pageEventHandlers.length).toBeGreaterThan(0)
  for (const handler of native.pageEventHandlers) {
    handler({ browserPageId: 'page-1', ...payload })
  }
}

describe('Tauri browser navigation updates', () => {
  beforeEach(() => {
    native.pageEventHandlers.length = 0
  })

  it('forwards committed navigations and title updates', () => {
    const seen = collectNavigationUpdates()
    emitPageEvent({ eventType: 'did-navigate', url: 'https://example.com/', title: null })
    emitPageEvent({
      eventType: 'page-title-updated',
      url: 'https://example.com/',
      title: 'Example'
    })
    expect(seen).toEqual([
      { browserPageId: 'page-1', url: 'https://example.com/', title: '' },
      { browserPageId: 'page-1', url: 'https://example.com/', title: 'Example' }
    ])
  })

  it('forwards same-document commits so SPA clicks update the tab url', () => {
    const seen = collectNavigationUpdates()
    emitPageEvent({
      eventType: 'did-navigate-in-page',
      url: 'https://example.com/#section',
      isInPlace: true
    })
    expect(seen).toEqual([
      { browserPageId: 'page-1', url: 'https://example.com/#section', title: '' }
    ])
  })

  it('keeps the known page title when the commit carries none', () => {
    native.invoke.mockImplementation(async (command: string) =>
      command === 'poc_browser_create' ? { url: 'https://example.com/' } : undefined
    )
    const container = document.createElement('div')
    document.body.appendChild(container)
    createTauriNativeBrowserWebview({
      browserPageId: 'page-1',
      container,
      partition: 'persist:orca-browser',
      visible: false
    })
    const seen = collectNavigationUpdates()
    emitPageEvent({
      eventType: 'page-title-updated',
      url: 'https://example.com/',
      title: 'Example'
    })
    emitPageEvent({ eventType: 'did-navigate', url: 'https://example.com/next', title: null })
    expect(seen).toEqual([
      { browserPageId: 'page-1', url: 'https://example.com/', title: 'Example' },
      { browserPageId: 'page-1', url: 'https://example.com/next', title: 'Example' }
    ])
    removeTauriNativeBrowserPage('page-1')
    document.body.replaceChildren()
  })

  it('ignores interim events like load starts and redirects', () => {
    const seen = collectNavigationUpdates()
    emitPageEvent({ eventType: 'did-start-loading', url: 'https://example.com/' })
    emitPageEvent({ eventType: 'did-redirect-navigation', url: 'https://example.com/login' })
    emitPageEvent({ eventType: 'did-stop-loading', url: 'https://example.com/' })
    expect(seen).toEqual([])
  })
})
