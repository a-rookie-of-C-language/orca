// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { tauriBrowserClientPageRendererBus } from './tauri-native-browser-client-page-renderer-bus'

const PAGE = {
  partition: 'persist:tauri-bus-test',
  browserPageId: 'bus-page',
  pageHostGeneration: 1
}

describe('Tauri browser client page renderer bus', () => {
  it('queues requests until a subscriber arrives', async () => {
    tauriBrowserClientPageRendererBus.resetForTest()
    const pending = tauriBrowserClientPageRendererBus.request({ type: 'mountPage', page: PAGE })
    const unsubscribe = tauriBrowserClientPageRendererBus.subscribe(() => ({
      type: 'mounted',
      webContentsId: 7
    }))
    await expect(pending).resolves.toEqual({ type: 'mounted', webContentsId: 7 })
    unsubscribe()
    tauriBrowserClientPageRendererBus.resetForTest()
  })

  it('fails mismatched outcomes instead of resolving them', async () => {
    tauriBrowserClientPageRendererBus.resetForTest()
    const unsubscribe = tauriBrowserClientPageRendererBus.subscribe(() => ({ type: 'retired' }))
    await expect(
      tauriBrowserClientPageRendererBus.request({ type: 'mountPage', page: PAGE })
    ).resolves.toEqual({ type: 'failed', errorCode: 'browser_client_page_renderer_result_invalid' })
    unsubscribe()
    tauriBrowserClientPageRendererBus.resetForTest()
  })

  it('fails queued requests when the subscriber is replaced', async () => {
    tauriBrowserClientPageRendererBus.resetForTest()
    const pending = tauriBrowserClientPageRendererBus.request({ type: 'mountPage', page: PAGE })
    const first = vi.fn(() => ({ type: 'mounted' as const, webContentsId: 1 }))
    tauriBrowserClientPageRendererBus.subscribe(first)
    const second = vi.fn(() => ({ type: 'mounted' as const, webContentsId: 2 }))
    tauriBrowserClientPageRendererBus.subscribe(second)
    await expect(pending).resolves.toEqual({
      type: 'failed',
      errorCode: 'browser_client_page_renderer_subscriber_replaced'
    })
    tauriBrowserClientPageRendererBus.resetForTest()
  })
})
