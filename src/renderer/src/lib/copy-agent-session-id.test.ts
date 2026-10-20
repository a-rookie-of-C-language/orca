import { beforeEach, describe, expect, it, vi } from 'vitest'
import { copyAgentSessionId } from './copy-agent-session-id'

const mocks = vi.hoisted(() => ({
  writeClipboardText: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError }
}))

describe('copyAgentSessionId', () => {
  beforeEach(() => {
    mocks.writeClipboardText.mockReset().mockResolvedValue(undefined)
    mocks.toastSuccess.mockReset()
    mocks.toastError.mockReset()
    Object.assign(globalThis, {
      window: { api: { ui: { writeClipboardText: mocks.writeClipboardText } } }
    })
  })

  it('writes the provider session id and confirms with a toast', async () => {
    await copyAgentSessionId('sess-123')

    expect(mocks.writeClipboardText).toHaveBeenCalledWith('sess-123')
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('toasts a failure instead of rejecting so the row button can retry', async () => {
    mocks.writeClipboardText.mockRejectedValue(new Error('denied'))

    await copyAgentSessionId('sess-123')

    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })
})
