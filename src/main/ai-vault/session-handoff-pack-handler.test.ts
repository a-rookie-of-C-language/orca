import { describe, expect, it, vi } from 'vitest'
import { handleAiVaultBuildHandoffPack } from './session-handoff-pack-handler'
import { readAiVaultHandoffPack } from './session-handoff-pack-read'

vi.mock('./session-handoff-pack-read', () => ({
  readAiVaultHandoffPack: vi.fn().mockResolvedValue({ text: null })
}))

const mockedRead = vi.mocked(readAiVaultHandoffPack)

describe('handleAiVaultBuildHandoffPack', () => {
  it('resolves null without a reader call for missing args', async () => {
    await expect(handleAiVaultBuildHandoffPack()).resolves.toEqual({ text: null })
    await expect(handleAiVaultBuildHandoffPack({} as never)).resolves.toEqual({ text: null })
    expect(mockedRead).not.toHaveBeenCalled()
  })

  it('resolves null for non-string agent or path', async () => {
    await expect(
      handleAiVaultBuildHandoffPack({ agent: 42, filePath: '/tmp/x.jsonl' } as never)
    ).resolves.toEqual({ text: null })
    expect(mockedRead).not.toHaveBeenCalled()
  })

  it('forwards only a known pack mode', async () => {
    await handleAiVaultBuildHandoffPack({
      agent: 'codex',
      filePath: '/tmp/x.jsonl',
      mode: 'bogus' as never,
      maxMessages: 'many' as never
    })
    expect(mockedRead).toHaveBeenCalledWith({
      agent: 'codex',
      filePath: '/tmp/x.jsonl',
      executionHostId: undefined
    })
  })

  it('forwards valid bounds', async () => {
    await handleAiVaultBuildHandoffPack({
      agent: 'pi',
      filePath: '/tmp/y.jsonl',
      mode: 'full',
      maxMessages: 5,
      maxChars: 500
    })
    expect(mockedRead).toHaveBeenCalledWith({
      agent: 'pi',
      filePath: '/tmp/y.jsonl',
      executionHostId: undefined,
      mode: 'full',
      maxMessages: 5,
      maxChars: 500
    })
  })
})
