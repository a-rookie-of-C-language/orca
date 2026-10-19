// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  executeTauriBrowserClientAutomation,
  isRecord,
  retireTauriBrowserClientAutomation
} from './tauri-native-browser-automation'
import {
  listTauriIframeSessions,
  resetTauriIframeSessionsForTest
} from './tauri-native-browser-iframe-sessions'
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

function readArgs(args: unknown): { command: string; sessionId: string; method: string } {
  if (!isRecord(args) || !isRecord(args.args)) {
    return { command: '', sessionId: '', method: '' }
  }
  const inner = args.args
  const sessionId = typeof inner.sessionId === 'string' ? inner.sessionId : ''
  const method = typeof inner.method === 'string' ? inner.method : ''
  return { command: '', sessionId, method }
}

const PARENT_TREE = {
  nodes: [
    {
      nodeId: '1',
      childIds: ['2'],
      role: { type: 'role', value: 'RootWebArea' },
      name: { type: 'computed', value: '' }
    },
    {
      nodeId: '2',
      role: { type: 'role', value: 'button' },
      name: { type: 'computedString', value: 'Parent' },
      backendDOMNodeId: 11
    }
  ]
}

const FRAME_TREE = {
  nodes: [
    {
      nodeId: '1',
      childIds: ['2'],
      role: { type: 'role', value: 'RootWebArea' },
      name: { type: 'computed', value: '' }
    },
    {
      nodeId: '2',
      role: { type: 'role', value: 'button' },
      name: { type: 'computedString', value: 'Framed' },
      backendDOMNodeId: 22
    }
  ]
}

function emitCdpEvent(payload: unknown): void {
  native.listeners.get('browser:cdp-event')?.(payload)
}

function emitAttached(targetId: string, sessionId: string, type: string): void {
  emitCdpEvent({
    browserPageId: 'page-1',
    event: 'Target.attachedToTarget',
    params: { sessionId, targetInfo: { targetId, type } }
  })
}

function mockRuntime(
  sessionBehavior: (method: string, expression: string) => unknown = () => ({ result: {} })
) {
  native.invoke.mockImplementation(async (command: string, args: unknown) => {
    if (command === 'poc_browser_cdp_subscribe') {
      return undefined
    }
    const parsed = readArgs(args)
    if (command === 'poc_browser_cdp_session') {
      const params = isRecord(args) && isRecord(args.args) ? args.args.params : {}
      const expression =
        isRecord(params) && typeof params.expression === 'string' ? params.expression : ''
      if (parsed.method === 'Accessibility.getFullAXTree') {
        return FRAME_TREE
      }
      return sessionBehavior(parsed.method, expression)
    }
    if (command !== 'poc_browser_cdp') {
      return undefined
    }
    if (parsed.method === 'Accessibility.getFullAXTree') {
      return PARENT_TREE
    }
    if (parsed.method === 'Target.getTargetInfo') {
      // Single-wrapped like the live pipe: the method result carries targetInfo at top level.
      return { targetInfo: { url: 'https://frame.example/' } }
    }
    if (parsed.method === 'Runtime.evaluate') {
      const params = isRecord(args) && isRecord(args.args) ? args.args.params : {}
      const expression =
        isRecord(params) && typeof params.expression === 'string' ? params.expression : ''
      if (expression.includes('iframe, frame')) {
        // Single-wrapped like the live pipe: Runtime.evaluate arrives as { result: RemoteObject }.
        return { result: { value: '[{"x":10,"y":20,"src":"https://frame.example/"}]' } }
      }
      return { result: { value: '[]' } }
    }
    if (parsed.method === 'Input.dispatchMouseEvent') {
      return { result: {} }
    }
    return { result: {} }
  })
}

beforeEach(() => {
  native.invoke.mockReset()
  mockRuntime()
  retireTauriBrowserClientAutomation('page-1')
  resetTauriBrowserCdpEventsForTest()
  resetTauriIframeSessionsForTest()
})

describe('Tauri browser iframe sessions', () => {
  it('tracks iframe attach and detaches by session', async () => {
    await executeTauriBrowserClientAutomation('page-1', 1, 'browser.snapshot', {})
    emitAttached('frame-1', 'session-a', 'iframe')
    emitAttached('worker-1', 'session-w', 'worker')
    expect([...listTauriIframeSessions('page-1').entries()]).toEqual([['frame-1', 'session-a']])
    emitCdpEvent({
      browserPageId: 'page-1',
      event: 'Target.detachedFromTarget',
      params: { sessionId: 'session-a' }
    })
    expect(listTauriIframeSessions('page-1').size).toBe(0)
  })

  it('appends iframe refs to the snapshot', async () => {
    // The first snapshot installs the native event sink; attach lands after.
    await executeTauriBrowserClientAutomation('page-1', 1, 'browser.snapshot', {})
    emitAttached('frame-1', 'session-a', 'iframe')
    const value = await executeTauriBrowserClientAutomation('page-1', 2, 'browser.snapshot', {})
    const snapshot = typeof value === 'object' && value !== null ? value : {}
    expect(JSON.stringify(snapshot)).toContain('Framed')
  })

  it('routes iframe element commands through the session with page-space coords', async () => {
    await executeTauriBrowserClientAutomation('page-1', 1, 'browser.snapshot', {})
    emitAttached('frame-1', 'session-a', 'iframe')
    mockRuntime((method) => {
      if (method === 'DOM.resolveNode') {
        return { object: { objectId: 'frame-object' } }
      }
      if (method === 'Runtime.callFunctionOn') {
        return {
          result: { value: { x: 5, y: 6, width: 50, height: 20 } }
        }
      }
      if (method === 'Accessibility.getFullAXTree') {
        return FRAME_TREE
      }
      return { result: {} }
    })
    // Re-snapshot so the iframe subtree is present with the session-aware mock.
    await executeTauriBrowserClientAutomation('page-1', 2, 'browser.snapshot', {})
    const clicked = await executeTauriBrowserClientAutomation('page-1', 2, 'browser.click', {
      element: '@e2'
    })
    expect(clicked).toEqual({ clicked: '@e2' })
    const sessionCalls = native.invoke.mock.calls.filter(([command, args]) => {
      const parsed = readArgs(args)
      return command === 'poc_browser_cdp_session' && parsed.sessionId === 'session-a'
    })
    expect(sessionCalls.length).toBeGreaterThan(0)
    const mouseCalls = native.invoke.mock.calls.filter(([command, args]) => {
      const parsed = readArgs(args)
      return command === 'poc_browser_cdp' && parsed.method === 'Input.dispatchMouseEvent'
    })
    expect(mouseCalls.length).toBe(2)
    const firstParams =
      isRecord(mouseCalls[0][1]) && isRecord(mouseCalls[0][1].args)
        ? mouseCalls[0][1].args.params
        : {}
    // Frame-local (5, 6) plus the frame offset (10, 20).
    expect(isRecord(firstParams) ? firstParams.x : -1).toBe(15)
    expect(isRecord(firstParams) ? firstParams.y : -1).toBe(26)
  })

  it('skips stale iframe sessions without failing the snapshot', async () => {
    await executeTauriBrowserClientAutomation('page-1', 1, 'browser.snapshot', {})
    emitAttached('frame-1', 'session-gone', 'iframe')
    native.invoke.mockImplementation(async (command: string, args: unknown) => {
      if (command === 'poc_browser_cdp_subscribe') {
        return undefined
      }
      const parsed = readArgs(args)
      if (command === 'poc_browser_cdp_session') {
        throw new Error('browser_cdp_error')
      }
      if (command !== 'poc_browser_cdp') {
        return undefined
      }
      if (parsed.method === 'Accessibility.getFullAXTree') {
        return PARENT_TREE
      }
      if (parsed.method === 'Runtime.evaluate') {
        return { result: { value: '[]' } }
      }
      return { result: {} }
    })
    const value = await executeTauriBrowserClientAutomation('page-1', 1, 'browser.snapshot', {})
    expect(JSON.stringify(value)).toContain('Parent')
    expect(JSON.stringify(value)).not.toContain('Framed')
  })
})
