import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubRuntimeEnvironmentBridge } from './runtime-environment-bridge-fixture'

type RuntimeSubscriptionCallbacks = {
  onResponse: (response: unknown) => void
}

describe('remote runtime terminal end verdict', () => {
  let callbacks: RuntimeSubscriptionCallbacks | null = null

  beforeEach(() => {
    vi.resetModules()
    callbacks = null
    stubRuntimeEnvironmentBridge({
      subscribe: vi.fn(async (_args, nextCallbacks: RuntimeSubscriptionCallbacks) => {
        callbacks = nextCallbacks
        queueMicrotask(() => {
          callbacks?.onResponse({ ok: true, result: { type: 'ready' } })
        })
        return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
      })
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    ['an explicit host verdict', { verdict: 'exited' }, 'exited', undefined],
    ['a proven host status', { verdict: 'exited', exitCode: 42 }, 'exited', 42],
    ['a non-integer host status', { verdict: 'exited', exitCode: 4.2 }, 'exited', undefined],
    ['a legacy bare end', {}, 'unverifiable', undefined],
    ['an unknown future verdict', { verdict: 'unknown' }, 'unverifiable', undefined]
  ])('maps %s to %s', async (_case, fields, expected, expectedCode) => {
    const { getRemoteRuntimeTerminalMultiplexer } =
      await import('./remote-runtime-terminal-multiplexer')
    const onEnd = vi.fn()
    const stream = await getRemoteRuntimeTerminalMultiplexer('env-1').subscribeTerminal({
      terminal: 'terminal-1',
      client: { id: 'desktop-1', type: 'desktop' },
      callbacks: { onData: vi.fn(), onSnapshot: vi.fn(), onEnd }
    })

    callbacks?.onResponse({
      ok: true,
      result: { type: 'end', streamId: stream.streamId, ...fields }
    })

    if (expectedCode === undefined) {
      expect(onEnd).toHaveBeenCalledWith(expected)
    } else {
      expect(onEnd).toHaveBeenCalledWith(expected, expectedCode)
    }
  })
})
