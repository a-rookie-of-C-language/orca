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

function readCdpCall(args: unknown): { method: string; params: Record<string, unknown> } {
  if (!isRecord(args) || !isRecord(args.args)) {
    return { method: '', params: {} }
  }
  const method = args.args.method
  const params = isRecord(args.args.params) ? args.args.params : {}
  return { method: typeof method === 'string' ? method : '', params }
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

beforeEach(() => {
  native.invoke.mockReset()
  native.invoke.mockImplementation(async (command: string, args: unknown) => {
    if (command === 'poc_browser_cdp_subscribe') {
      return undefined
    }
    if (command !== 'poc_browser_cdp') {
      return undefined
    }
    if (readCdpCall(args).method === 'Accessibility.getFullAXTree') {
      return AX_TREE
    }
    return { result: {} }
  })
  retireTauriBrowserClientAutomation('page-1')
  resetTauriBrowserCdpEventsForTest()
})

describe('Tauri browser setDevice', () => {
  it('applies metrics, touch and UA for a known preset', async () => {
    await executeTauriBrowserClientAutomation('page-1', 1, 'browser.snapshot', {})
    const value = await executeTauriBrowserClientAutomation('page-1', 1, 'browser.setDevice', {
      name: 'iPhone 15'
    })
    expect(value).toEqual({
      device: 'iPhone 15',
      width: 393,
      height: 659,
      deviceScaleFactor: 3,
      mobile: true
    })
    const calls = native.invoke.mock.calls
      .filter(([command]) => command === 'poc_browser_cdp')
      .map(([, args]) => readCdpCall(args))
    const metrics = calls.find((call) => call.method === 'Emulation.setDeviceMetricsOverride')
    expect(metrics?.params).toMatchObject({ width: 393, height: 659, deviceScaleFactor: 3 })
    const touch = calls.find((call) => call.method === 'Emulation.setTouchEmulationEnabled')
    expect(touch?.params).toEqual({ enabled: true })
    const ua = calls.find((call) => call.method === 'Network.setUserAgentOverride')
    expect(typeof ua?.params.userAgent).toBe('string')
    expect(String(ua?.params.userAgent)).toContain('iPhone')
  })

  it('fails closed for unknown names and missing params', async () => {
    await executeTauriBrowserClientAutomation('page-1', 1, 'browser.snapshot', {})
    await expect(
      executeTauriBrowserClientAutomation('page-1', 1, 'browser.setDevice', {
        name: 'Toaster 3000'
      })
    ).rejects.toThrow('browser_command_unavailable')
    await expect(
      executeTauriBrowserClientAutomation('page-1', 1, 'browser.setDevice', {})
    ).rejects.toThrow('browser_invalid_params')
  })
})
