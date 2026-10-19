// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withTauriAgentBrowserInput } from './tauri-native-browser-agent-input'

type HostCall = unknown[]
const host = vi.hoisted((): { available: boolean; calls: HostCall[]; failBegin: boolean } => ({
  available: true,
  calls: [],
  failBegin: false
}))

vi.mock('./tauri-native-host', () => ({
  isTauriNativeHost: () => host.available,
  invokeNative: (...args: unknown[]) => {
    host.calls.push(args)
    if (host.failBegin && args[0] === 'poc_browser_agent_input_begin') {
      return Promise.reject(new Error('denied'))
    }
    return Promise.resolve()
  }
}))

describe('withTauriAgentBrowserInput', () => {
  beforeEach(() => {
    host.available = true
    host.calls.length = 0
    host.failBegin = false
  })

  it('marks the page around the run', async () => {
    const order: string[] = []
    const result = await withTauriAgentBrowserInput('page-1', async () => {
      order.push('run')
      return 42
    })
    expect(result).toBe(42)
    expect(host.calls).toEqual([
      ['poc_browser_agent_input_begin', { args: { browserPageId: 'page-1' } }],
      ['poc_browser_agent_input_end', { args: { browserPageId: 'page-1' } }]
    ])
    expect(order).toEqual(['run'])
  })

  it('ends the mark when the run throws', async () => {
    await expect(
      withTauriAgentBrowserInput('page-1', () => Promise.reject(new Error('boom')))
    ).rejects.toThrow('boom')
    expect(host.calls).toEqual([
      ['poc_browser_agent_input_begin', { args: { browserPageId: 'page-1' } }],
      ['poc_browser_agent_input_end', { args: { browserPageId: 'page-1' } }]
    ])
  })

  it('runs unmarked when begin is denied', async () => {
    host.failBegin = true
    const result = await withTauriAgentBrowserInput('page-1', async () => 'ok')
    expect(result).toBe('ok')
    expect(host.calls).toEqual([
      ['poc_browser_agent_input_begin', { args: { browserPageId: 'page-1' } }]
    ])
  })

  it('runs without marking off the Tauri host', async () => {
    host.available = false
    const result = await withTauriAgentBrowserInput('page-1', async () => 'ok')
    expect(result).toBe('ok')
    expect(host.calls).toEqual([])
  })
})
