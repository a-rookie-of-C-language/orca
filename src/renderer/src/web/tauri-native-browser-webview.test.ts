// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTauriNativeBrowserWebview,
  hasTauriNativeBrowserPage,
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

const browserPageId = 'tauri-browser-lifecycle-test'

function createPage() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const webview = createTauriNativeBrowserWebview({
    browserPageId,
    container,
    partition: 'persist:orca-browser',
    visible: false
  })
  return { container, webview }
}

function closeCalls() {
  return native.invoke.mock.calls.filter(([command]) => command === 'poc_browser_close')
}

describe('Tauri browser webview removal', () => {
  beforeEach(() => {
    native.invoke
      .mockReset()
      .mockImplementation(async (command: string) =>
        command === 'poc_browser_create' ? { url: 'about:blank' } : undefined
      )
  })

  afterEach(() => {
    removeTauriNativeBrowserPage(browserPageId)
    document.body.replaceChildren()
  })

  it('detaches the proxy and closes its native page exactly once', async () => {
    const { container, webview } = createPage()
    await vi.waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith('poc_browser_set_bounds', expect.anything())
    )

    expect(() => webview.remove()).not.toThrow()
    webview.remove()

    expect(container.children).toHaveLength(0)
    expect(hasTauriNativeBrowserPage(browserPageId)).toBe(false)
    await vi.waitFor(() => expect(closeCalls()).toHaveLength(1))
    expect(closeCalls()[0]).toEqual(['poc_browser_close', { args: { browserPageId } }])
  })

  it('supports removal through the browser page registry', async () => {
    const { container } = createPage()

    expect(() => removeTauriNativeBrowserPage(browserPageId)).not.toThrow()
    removeTauriNativeBrowserPage(browserPageId)

    expect(container.children).toHaveLength(0)
    expect(hasTauriNativeBrowserPage(browserPageId)).toBe(false)
    await vi.waitFor(() => expect(closeCalls()).toHaveLength(1))
  })

  it('waits for pending native creation before closing a removed page', async () => {
    const pending = Promise.withResolvers<{ url: string }>()
    native.invoke.mockImplementation((command: string) =>
      command === 'poc_browser_create' ? pending.promise : Promise.resolve()
    )
    const { container, webview } = createPage()

    expect(() => webview.remove()).not.toThrow()
    expect(container.children).toHaveLength(0)
    expect(closeCalls()).toHaveLength(0)

    pending.resolve({ url: 'about:blank' })
    await vi.waitFor(() => expect(closeCalls()).toHaveLength(1))
    expect(hasTauriNativeBrowserPage(browserPageId)).toBe(false)
  })
  describe('Tauri browser webview find', () => {
    beforeEach(() => {
      native.invoke.mockReset().mockImplementation(async (command: string, args: unknown) => {
        if (command === 'poc_browser_create') {
          return { url: 'about:blank' }
        }
        if (command === 'poc_browser_cdp') {
          const params = (args as { args?: { method?: string } }).args
          if (params?.method === 'Runtime.evaluate') {
            return { result: { value: { found: true, matches: 3, ordinal: 1 } } }
          }
          return { result: {} }
        }
        return undefined
      })
    })
    afterEach(() => {
      removeTauriNativeBrowserPage(browserPageId)
      document.body.replaceChildren()
    })
    it('reports match counts through found-in-page', async () => {
      const { webview } = createPage()
      const seen: unknown[] = []
      webview.addEventListener('found-in-page', (event: Event) => {
        seen.push((event as unknown as { result: unknown }).result)
      })
      webview.findInPage('foo')
      await vi.waitFor(() =>
        expect(seen).toEqual([
          { requestId: expect.any(Number), activeMatchOrdinal: 1, matches: 3, finalUpdate: true }
        ])
      )
    })
    it('clears the selection on stopFindInPage', async () => {
      const { webview } = createPage()
      webview.stopFindInPage('clearSelection')
      await vi.waitFor(() =>
        expect(
          native.invoke.mock.calls.some(
            ([command, args]) =>
              command === 'poc_browser_cdp' && JSON.stringify(args).includes('removeAllRanges')
          )
        ).toBe(true)
      )
    })
    it('reloads ignoring the cache with a plain-reload fallback', async () => {
      const { webview } = createPage()
      webview.reloadIgnoringCache()
      await vi.waitFor(() =>
        expect(native.invoke).toHaveBeenCalledWith(
          'poc_browser_cdp',
          expect.objectContaining({
            args: expect.objectContaining({ method: 'Page.reload' })
          })
        )
      )
    })
  })
  describe('Tauri browser webview lifecycle parity events', () => {
    beforeEach(() => {
      native.invoke.mockReset().mockImplementation(async (command: string) => {
        if (command === 'poc_browser_create') {
          return { url: 'https://example.com/' }
        }
        return undefined
      })
    })
    afterEach(() => {
      removeTauriNativeBrowserPage(browserPageId)
      document.body.replaceChildren()
    })

    function emitPageEvent(payload: Record<string, unknown>) {
      expect(native.pageEventHandlers).toHaveLength(1)
      for (const handler of native.pageEventHandlers) {
        handler({ browserPageId, ...payload })
      }
    }

    function collectEvents(webview: Electron.WebviewTag, name: string) {
      const seen: unknown[] = []
      webview.addEventListener(name, (event: Event) => {
        seen.push(event)
      })
      return seen
    }

    it('forwards redirect navigations with commit metadata', () => {
      const { webview } = createPage()
      const seen = collectEvents(webview, 'did-redirect-navigation')
      emitPageEvent({
        eventType: 'did-redirect-navigation',
        url: 'https://example.com/login',
        isMainFrame: true,
        isInPlace: false
      })
      expect(seen).toHaveLength(1)
      const detail = seen[0] as Record<string, unknown>
      expect(detail.url).toBe('https://example.com/login')
      expect(detail.isMainFrame).toBe(true)
      expect(detail.isInPlace).toBe(false)
      expect(webview.getURL()).toBe('https://example.com/login')
    })

    it('forwards same-document commits as in-place navigations', () => {
      const { webview } = createPage()
      const seen = collectEvents(webview, 'did-navigate-in-page')
      emitPageEvent({
        eventType: 'did-navigate-in-page',
        url: 'https://example.com/#section',
        isMainFrame: true,
        isInPlace: true
      })
      expect(seen).toHaveLength(1)
      const detail = seen[0] as Record<string, unknown>
      expect(detail.url).toBe('https://example.com/#section')
      expect(detail.isInPlace).toBe(true)
      expect(webview.getURL()).toBe('https://example.com/#section')
    })

    it('forwards favicon updates without touching the committed url', async () => {
      const { webview } = createPage()
      await vi.waitFor(() => expect(webview.getURL()).toBe('https://example.com/'))
      const seen = collectEvents(webview, 'page-favicon-updated')
      emitPageEvent({
        eventType: 'page-favicon-updated',
        favicons: ['https://example.com/favicon.ico']
      })
      expect(seen).toHaveLength(1)
      const detail = seen[0] as Record<string, unknown>
      expect(detail.favicons).toEqual(['https://example.com/favicon.ico'])
      expect(webview.getURL()).toBe('https://example.com/')
    })

    it('forwards renderer crashes with the Electron reason', async () => {
      const { webview } = createPage()
      await vi.waitFor(() => expect(webview.getURL()).toBe('https://example.com/'))
      const seen = collectEvents(webview, 'render-process-gone')
      emitPageEvent({ eventType: 'render-process-gone', reason: 'crashed', exitCode: 3 })
      expect(seen).toHaveLength(1)
      const detail = seen[0] as Record<string, unknown>
      expect(detail.reason).toBe('crashed')
      expect(detail.exitCode).toBe(3)
      expect(webview.getURL()).toBe('https://example.com/')
    })
  })
})
