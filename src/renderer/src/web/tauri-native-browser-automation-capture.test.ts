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

function emitConsole(page: string, text: string): void {
  emitCdpEvent({
    browserPageId: page,
    event: 'Runtime.consoleAPICalled',
    params: { type: 'log', args: [{ type: 'string', value: text }], timestamp: 1_700_000_000_000 }
  })
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

describe('Tauri browser capture', () => {
  it('reads nothing outside a capture and enables domains on start', async () => {
    await executeTauriBrowserClientAutomation('page-1', 1, 'browser.snapshot', {})
    emitConsole('page-1', 'before')
    const empty = await executeTauriBrowserClientAutomation('page-1', 1, 'browser.console', {})
    expect(empty).toEqual({ entries: [], truncated: false })
    const started = await executeTauriBrowserClientAutomation(
      'page-1',
      1,
      'browser.capture.start',
      {}
    )
    expect(started).toEqual({ capturing: true })
    const methods = native.invoke.mock.calls
      .filter(([command]) => command === 'poc_browser_cdp')
      .map(([, args]) => readCdpMethod(args))
    expect(methods).toContain('Runtime.enable')
    expect(methods).toContain('Network.enable')
  })

  it('drops stale history on start and freezes reads on stop', async () => {
    await executeTauriBrowserClientAutomation('page-1', 1, 'browser.snapshot', {})
    await executeTauriBrowserClientAutomation('page-1', 1, 'browser.capture.start', {})
    emitConsole('page-1', 'first')
    await executeTauriBrowserClientAutomation('page-1', 1, 'browser.capture.start', {})
    const cleared = await executeTauriBrowserClientAutomation('page-1', 1, 'browser.console', {})
    expect(cleared).toEqual({ entries: [], truncated: false })
    emitConsole('page-1', 'second')
    const stopped = await executeTauriBrowserClientAutomation(
      'page-1',
      1,
      'browser.capture.stop',
      {}
    )
    expect(stopped).toEqual({ stopped: true })
    emitConsole('page-1', 'after-stop')
    const value = await executeTauriBrowserClientAutomation('page-1', 1, 'browser.console', {})
    expect(value).toEqual({
      entries: [{ level: 'log', text: 'second', timestamp: 1_700_000_000_000 }],
      truncated: false
    })
  })

  it('slices reads to the limit with a truncated flag', async () => {
    await executeTauriBrowserClientAutomation('page-1', 1, 'browser.snapshot', {})
    await executeTauriBrowserClientAutomation('page-1', 1, 'browser.capture.start', {})
    emitConsole('page-1', 'one')
    emitConsole('page-1', 'two')
    emitConsole('page-1', 'three')
    const value = await executeTauriBrowserClientAutomation('page-1', 1, 'browser.console', {
      limit: 2
    })
    expect(value).toEqual({
      entries: [
        { level: 'log', text: 'two', timestamp: 1_700_000_000_000 },
        { level: 'log', text: 'three', timestamp: 1_700_000_000_000 }
      ],
      truncated: true
    })
  })
})
