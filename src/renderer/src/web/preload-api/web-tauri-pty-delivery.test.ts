import { describe, expect, it, vi } from 'vitest'
import {
  callbacks,
  createTauriPtyApi,
  callTauriPtyHost,
  requireActiveEnvironment,
  spawn,
  stream
} from './web-tauri-pty-test-fixture'

describe('Tauri PTY input settlement', () => {
  it('confirms legacy writes on the bound host without also sending stream input', async () => {
    const api = createTauriPtyApi()
    const result = await spawn(false)
    requireActiveEnvironment.mockReturnValue({ id: 'env-2' })
    callTauriPtyHost.mockResolvedValueOnce({ send: { accepted: true } })

    await expect(
      api.writeAccepted(result.id, 'echo accepted\r', 'driving', {
        requireWriteSettlement: true
      })
    ).resolves.toBe(true)

    expect(stream.sent).toEqual([])
    expect(callTauriPtyHost).toHaveBeenCalledExactlyOnceWith(result.id, 'terminal.send', {
      terminal: 'terminal-1',
      text: 'echo accepted\r',
      requireWriteSettlement: true,
      expectedIncarnationId: 'incarnation-terminal-1',
      client: { id: `tauri-pty:${result.id}`, type: 'desktop' }
    })
  })

  it('notifies the renderer when the execution host refuses a settled write', async () => {
    const api = createTauriPtyApi()
    const result = await spawn(false)
    const unavailable = vi.fn()
    const unsubscribe = api.onWriteUnavailable?.(unavailable)
    callTauriPtyHost.mockResolvedValueOnce({ send: { accepted: false } })
    try {
      await expect(
        api.writeAccepted(result.id, 'echo refused\r', 'driving', {
          requireWriteSettlement: true
        })
      ).resolves.toBe(false)
      expect(unavailable).toHaveBeenCalledExactlyOnceWith({ id: result.id })
      expect(stream.sent).toEqual([])
    } finally {
      unsubscribe?.()
    }
  })

  it('rejects an unverifiable write rather than resending through the stream', async () => {
    const api = createTauriPtyApi()
    const result = await spawn(false)
    callTauriPtyHost.mockResolvedValueOnce({ send: {} })

    await expect(
      api.writeAccepted(result.id, 'echo unknown\r', 'driving', { requireWriteSettlement: true })
    ).rejects.toThrow('PTY write acknowledgment unavailable')
    expect(stream.sent).toEqual([])
  })

  it('waits for stream acknowledgment without invoking the unary fallback', async () => {
    const api = createTauriPtyApi()
    const result = await spawn(true)
    const pending = api.writeAccepted(result.id, 'echo sequenced\r', 'driving', {
      requireWriteSettlement: true
    })
    expect(stream.sent).toEqual([{ text: 'echo sequenced\r', seq: 1 }])
    callbacks.onInputAck?.(1, 'applied')
    await expect(pending).resolves.toBe(true)
    expect(callTauriPtyHost).not.toHaveBeenCalled()
  })

  it.each([false, true])('never replays a settled query reply (input acks=%s)', async (acks) => {
    const api = createTauriPtyApi()
    const result = await spawn(acks)

    await expect(
      api.writeAccepted(result.id, '\u001b[1;1R', 'query-reply', { requireWriteSettlement: true })
    ).resolves.toBe(false)
    expect(stream.sent).toEqual([])
    expect(callTauriPtyHost).not.toHaveBeenCalled()
  })
})

describe('Tauri PTY replacement stream isolation', () => {
  it.each(['unverifiable', 'error'] as const)(
    'preserves pending input across an unverified stream end (%s)',
    async (reason) => {
      const api = createTauriPtyApi()
      const first = await spawn(true)
      const pending = api.writeAccepted(first.id, 'echo retained\r', 'driving')
      const onExit = vi.fn()
      const unsubscribe = api.onExit(onExit)
      try {
        if (reason === 'unverifiable') {
          callbacks.onEnd?.('unverifiable')
        } else {
          callbacks.onError?.('connection interrupted')
        }
        expect(onExit).toHaveBeenCalledExactlyOnceWith({
          id: first.id,
          code: 1,
          preserveRendererBinding: true
        })
        await spawn(true, {}, 'terminal-1')
        expect(stream.sent).toEqual([{ text: 'echo retained\r', seq: 1 }])
        callbacks.onInputAck?.(1, 'applied')
        await expect(pending).resolves.toBe(true)
      } finally {
        unsubscribe()
      }
    }
  )

  it('ignores old output and terminal-end events after replacing a stream', async () => {
    const api = createTauriPtyApi()
    const first = await spawn(true)
    const previousCallbacks = callbacks
    const previousStream = stream
    vi.mocked(previousStream.close).mockImplementation(() => previousCallbacks.onEnd?.('exited'))
    await spawn(true, {}, 'terminal-1')
    const onData = vi.fn()
    const onReplay = vi.fn()
    const onExit = vi.fn()
    const unsubscribes = [api.onData(onData), api.onReplay(onReplay), api.onExit(onExit)]
    try {
      previousCallbacks.onSnapshot?.('stale replay')
      previousCallbacks.onData?.('stale output')
      previousCallbacks.onEnd?.('exited')
      previousCallbacks.onError?.('old stream')
      previousCallbacks.onTransportClose?.({ recoverable: true, retryWithBackoff: true })
      expect(onData).not.toHaveBeenCalled()
      expect(onReplay).not.toHaveBeenCalled()
      expect(onExit).not.toHaveBeenCalled()
      await expect(api.getSize(first.id)).resolves.toEqual({ cols: 80, rows: 24 })

      const pending = api.writeAccepted(first.id, 'echo new\r', 'driving')
      let settled = false
      void pending.then(() => {
        settled = true
      })
      previousCallbacks.onInputAck?.(1, 'applied')
      await Promise.resolve()
      expect(settled).toBe(false)
      callbacks.onInputAck?.(1, 'applied')
      await expect(pending).resolves.toBe(true)
      callbacks.onEnd?.('exited')
      expect(onExit).toHaveBeenCalledExactlyOnceWith({ id: first.id, code: 0 })
    } finally {
      for (const unsubscribe of unsubscribes) {
        unsubscribe()
      }
    }
  })
})
