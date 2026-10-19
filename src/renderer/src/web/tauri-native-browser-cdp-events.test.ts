// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  executeTauriBrowserClientAutomation,
  isRecord,
  retireTauriBrowserClientAutomation
} from './tauri-native-browser-automation'
import { resetTauriBrowserCdpEventsForTest } from './tauri-native-browser-cdp-events'

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
})

describe('Tauri browser CDP event logs', () => {
  it('reads buffered console entries with call frames', async () => {
    await executeTauriBrowserClientAutomation('page-1', 1, 'browser.snapshot', {})
    // Capture opens the buffer window and subscribes the domains.
    await executeTauriBrowserClientAutomation('page-1', 1, 'browser.capture.start', {})
    emitCdpEvent({
      browserPageId: 'page-1',
      event: 'Runtime.consoleAPICalled',
      params: {
        type: 'warning',
        args: [
          { type: 'string', value: 'hello' },
          { type: 'number', description: '42' }
        ],
        timestamp: 1_700_000_000_000,
        stackTrace: { callFrames: [{ url: 'https://example.com/app.js', lineNumber: 10 }] }
      }
    })
    emitCdpEvent({
      browserPageId: 'page-1',
      event: 'Runtime.exceptionThrown',
      params: {
        timestamp: 1_700_000_000_001,
        exceptionDetails: { text: 'boom', exception: { description: 'Error: boom' } }
      }
    })
    const value = await executeTauriBrowserClientAutomation('page-1', 1, 'browser.console', {})
    expect(value).toEqual({
      entries: [
        {
          level: 'warning',
          text: 'hello 42',
          timestamp: 1_700_000_000_000,
          url: 'https://example.com/app.js',
          line: 10
        },
        { level: 'error', text: 'Error: boom', timestamp: 1_700_000_000_001 }
      ],
      truncated: false
    })
    expect(native.invoke).toHaveBeenCalledWith('poc_browser_cdp_subscribe', {
      args: { browserPageId: 'page-1', eventName: 'Runtime.consoleAPICalled' }
    })
  })

  it('assembles network entries across the request lifecycle', async () => {
    await executeTauriBrowserClientAutomation('page-1', 1, 'browser.snapshot', {})
    await executeTauriBrowserClientAutomation('page-1', 1, 'browser.capture.start', {})
    emitCdpEvent({
      browserPageId: 'page-1',
      event: 'Network.requestWillBeSent',
      params: {
        requestId: 'r1',
        request: { url: 'https://example.com/a', method: 'GET' },
        timestamp: 1_700_000_000_000
      }
    })
    emitCdpEvent({
      browserPageId: 'page-1',
      event: 'Network.responseReceived',
      params: {
        requestId: 'r1',
        response: { status: 200, mimeType: 'text/html' },
        timestamp: 1_700_000_000_100
      }
    })
    emitCdpEvent({
      browserPageId: 'page-1',
      event: 'Network.loadingFinished',
      params: { requestId: 'r1', encodedDataLength: 1234, timestamp: 1_700_000_000_200 }
    })
    emitCdpEvent({
      browserPageId: 'page-1',
      event: 'Network.requestWillBeSent',
      params: {
        requestId: 'r2',
        request: { url: 'https://example.com/b', method: 'POST' },
        timestamp: 1_700_000_000_300
      }
    })
    emitCdpEvent({
      browserPageId: 'page-1',
      event: 'Network.loadingFailed',
      params: { requestId: 'r2', errorText: 'net::ERR_FAILED', timestamp: 1_700_000_000_400 }
    })
    const value = await executeTauriBrowserClientAutomation('page-1', 1, 'browser.network', {})
    expect(value).toEqual({
      entries: [
        {
          url: 'https://example.com/a',
          method: 'GET',
          status: 200,
          mimeType: 'text/html',
          size: 1234,
          timestamp: 1_700_000_000_000
        },
        {
          url: 'https://example.com/b',
          method: 'POST',
          status: 0,
          mimeType: '',
          size: 0,
          timestamp: 1_700_000_000_300
        }
      ],
      truncated: false
    })
  })

  it('closes redirect legs and ignores orphan events', async () => {
    await executeTauriBrowserClientAutomation('page-1', 1, 'browser.snapshot', {})
    await executeTauriBrowserClientAutomation('page-1', 1, 'browser.capture.start', {})
    emitCdpEvent({
      browserPageId: 'page-1',
      event: 'Network.requestWillBeSent',
      params: {
        requestId: 'r9',
        request: { url: 'https://example.com/old', method: 'GET' },
        timestamp: 1_700_000_000_000
      }
    })
    emitCdpEvent({
      browserPageId: 'page-1',
      event: 'Network.responseReceived',
      params: {
        requestId: 'r9',
        response: { status: 301, mimeType: '' },
        timestamp: 1_700_000_000_050
      }
    })
    emitCdpEvent({
      browserPageId: 'page-1',
      event: 'Network.requestWillBeSent',
      params: {
        requestId: 'r9',
        redirectResponse: { status: 301 },
        request: { url: 'https://example.com/new', method: 'GET' },
        timestamp: 1_700_000_000_060
      }
    })
    emitCdpEvent({
      browserPageId: 'page-1',
      event: 'Network.loadingFinished',
      params: { requestId: 'r9', encodedDataLength: 10, timestamp: 1_700_000_000_100 }
    })
    emitCdpEvent({
      browserPageId: 'page-1',
      event: 'Network.responseReceived',
      params: { requestId: 'orphan', response: { status: 200 }, timestamp: 1 }
    })
    const value = await executeTauriBrowserClientAutomation('page-1', 1, 'browser.network', {})
    expect(value).toEqual({
      entries: [
        {
          url: 'https://example.com/old',
          method: 'GET',
          status: 301,
          mimeType: '',
          size: 0,
          timestamp: 1_700_000_000_000
        },
        {
          url: 'https://example.com/new',
          method: 'GET',
          status: 0,
          mimeType: '',
          size: 10,
          timestamp: 1_700_000_000_060
        }
      ],
      truncated: false
    })
  })

  it('normalizes second-unit timestamps and drops malformed payloads', async () => {
    await executeTauriBrowserClientAutomation('page-1', 1, 'browser.snapshot', {})
    await executeTauriBrowserClientAutomation('page-1', 1, 'browser.capture.start', {})
    emitCdpEvent({
      browserPageId: 'page-1',
      event: 'Runtime.consoleAPICalled',
      params: { type: 'log', args: [{ type: 'string', value: 's' }], timestamp: 1_700_000_000.5 }
    })
    emitCdpEvent(null)
    emitCdpEvent({ browserPageId: 'page-1' })
    emitCdpEvent({ browserPageId: 'other', event: 'Runtime.consoleAPICalled', params: {} })
    const value = await executeTauriBrowserClientAutomation('page-1', 1, 'browser.console', {})
    expect(value).toEqual({
      entries: [{ level: 'log', text: 's', timestamp: 1_700_000_000_500 }],
      truncated: false
    })
  })
})
