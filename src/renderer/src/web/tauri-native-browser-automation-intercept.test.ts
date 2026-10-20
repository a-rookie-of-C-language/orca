// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  executeTauriBrowserClientAutomation,
  isRecord,
  retireTauriBrowserClientAutomation
} from './tauri-native-browser-automation'
import { resetTauriBrowserCdpEventsForTest } from './tauri-native-browser-cdp-events'
import { resetTauriBrowserInterceptForTest } from './tauri-native-browser-automation-intercept'

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (payload: unknown) => void>()
}))
vi.mock('./tauri-native-host', () => ({
  isTauriNativeHost: () => true,
  invokeNative: native.invoke,
  listenNative: (event: string, handler: (payload: unknown) => void) => {
    native.listeners.set(event, handler)
    return () => {}
  }
}))
vi.mock('./tauri-native-browser-webview', () => ({
  getTauriNativeBrowserPageInfo: () => ({ url: 'https://example.com/', title: 'Example' })
}))

function readCdpMethod(args: unknown): string {
  if (!isRecord(args) || !isRecord(args.args)) {
    return ''
  }
  const method = args.args.method
  return typeof method === 'string' ? method : ''
}

const AX_TREE = {
  nodes: [
    {
      nodeId: '1',
      childIds: [],
      role: { type: 'role', value: 'RootWebArea' },
      name: { type: 'computed', value: '' }
    }
  ]
}

function emitCdpEvent(payload: unknown): void {
  native.listeners.get('browser:cdp-event')?.(payload)
}

beforeEach(() => {
  native.invoke.mockReset()
  native.invoke.mockImplementation(async (command: string, args: unknown) => {
    if (command === 'poc_browser_cdp_subscribe') {
      return undefined
    }
    if (command !== 'poc_browser_cdp') {
      return undefined
    }
    if (readCdpMethod(args) === 'Accessibility.getFullAXTree') {
      return AX_TREE
    }
    return { result: {} }
  })
  retireTauriBrowserClientAutomation('page-1')
  resetTauriBrowserCdpEventsForTest()
  resetTauriBrowserInterceptForTest()
})

describe('Tauri browser intercept', () => {
  it('records sent requests without holding them', async () => {
    await executeTauriBrowserClientAutomation('page-1', 1, 'browser.snapshot', {})
    const enabled = await executeTauriBrowserClientAutomation(
      'page-1',
      1,
      'browser.intercept.enable',
      { patterns: ['*://example.com/*'] }
    )
    expect(enabled).toEqual({ enabled: true, patterns: ['*://example.com/*'] })
    emitCdpEvent({
      browserPageId: 'page-1',
      event: 'Network.requestWillBeSent',
      params: {
        requestId: 'sent-1',
        request: {
          url: 'https://example.com/app.js',
          method: 'GET',
          headers: { accept: '*/*' }
        },
        type: 'Script'
      }
    })
    emitCdpEvent({
      browserPageId: 'page-1',
      event: 'Network.requestWillBeSent',
      params: {
        requestId: 'sent-2',
        request: {
          url: 'https://other.test/style.css',
          method: 'GET',
          headers: {}
        },
        type: 'Stylesheet'
      }
    })
    const listed = await executeTauriBrowserClientAutomation(
      'page-1',
      1,
      'browser.intercept.list',
      {}
    )
    expect(listed).toEqual({
      requests: [
        {
          id: 'sent-1',
          url: 'https://example.com/app.js',
          method: 'GET',
          headers: { accept: '*/*' },
          resourceType: 'Script'
        }
      ]
    })
    const enabledNetwork = native.invoke.mock.calls.some(
      ([command, args]) => command === 'poc_browser_cdp' && readCdpMethod(args) === 'Network.enable'
    )
    expect(enabledNetwork).toBe(true)
    const held = native.invoke.mock.calls.some(
      ([command, args]) => command === 'poc_browser_cdp' && readCdpMethod(args) === 'Fetch.enable'
    )
    expect(held).toBe(false)
  })

  it('defaults patterns and clears on disable', async () => {
    await executeTauriBrowserClientAutomation('page-1', 1, 'browser.snapshot', {})
    const enabled = await executeTauriBrowserClientAutomation(
      'page-1',
      1,
      'browser.intercept.enable',
      {}
    )
    expect(enabled).toEqual({ enabled: true, patterns: ['*'] })
    const disabled = await executeTauriBrowserClientAutomation(
      'page-1',
      1,
      'browser.intercept.disable',
      {}
    )
    expect(disabled).toEqual({ disabled: true })
    const listed = await executeTauriBrowserClientAutomation(
      'page-1',
      1,
      'browser.intercept.list',
      {}
    )
    expect(listed).toEqual({ requests: [] })
  })
})
