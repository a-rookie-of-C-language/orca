// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  buildAgentSessionContinuationPrompt,
  fetchEmbeddedHandoffText,
  type AgentSessionContinuationSource
} from './agent-session-continuation'

const originalApi = window.api

afterEach(() => {
  window.api = originalApi
})

function sourceWith(
  overrides: Partial<AgentSessionContinuationSource>
): AgentSessionContinuationSource {
  return {
    sourceAgent: 'codex',
    capturedText: '',
    transcriptPath: '/tmp/codex-session.jsonl',
    ...overrides
  }
}

function installBridge(buildHandoffPack: unknown): void {
  window.api = { aiVault: { buildHandoffPack } } as never
}

describe('fetchEmbeddedHandoffText', () => {
  it('keeps same-agent handoffs on the raw-path flow', async () => {
    const buildHandoffPack = vi.fn()
    installBridge(buildHandoffPack)
    await expect(
      fetchEmbeddedHandoffText(sourceWith({ sourceAgent: 'codex' }), 'codex' as TuiAgent)
    ).resolves.toBeNull()
    expect(buildHandoffPack).not.toHaveBeenCalled()
  })

  it('skips sources without a transcript decoder', async () => {
    const buildHandoffPack = vi.fn()
    installBridge(buildHandoffPack)
    await expect(
      fetchEmbeddedHandoffText(
        sourceWith({ sourceAgent: 'opencode' as TuiAgent }),
        'pi' as TuiAgent
      )
    ).resolves.toBeNull()
    expect(buildHandoffPack).not.toHaveBeenCalled()
  })

  it('skips sources without a transcript path', async () => {
    const buildHandoffPack = vi.fn()
    installBridge(buildHandoffPack)
    await expect(
      fetchEmbeddedHandoffText(sourceWith({ transcriptPath: null }), 'pi' as TuiAgent)
    ).resolves.toBeNull()
    expect(buildHandoffPack).not.toHaveBeenCalled()
  })

  it('returns decoded text for a cross-provider handoff', async () => {
    const buildHandoffPack = vi.fn().mockResolvedValue({ text: '**user**: hi', truncated: false })
    installBridge(buildHandoffPack)
    await expect(
      fetchEmbeddedHandoffText(sourceWith({ sourceAgent: 'codex' }), 'pi' as TuiAgent)
    ).resolves.toBe('**user**: hi')
    expect(buildHandoffPack).toHaveBeenCalledWith({
      agent: 'codex',
      filePath: '/tmp/codex-session.jsonl',
      mode: 'summary'
    })
  })

  it('falls back to null when the bridge is missing or fails', async () => {
    installBridge(undefined)
    await expect(fetchEmbeddedHandoffText(sourceWith({}), 'pi' as TuiAgent)).resolves.toBeNull()
    installBridge(vi.fn().mockRejectedValue(new Error('ipc down')))
    await expect(fetchEmbeddedHandoffText(sourceWith({}), 'pi' as TuiAgent)).resolves.toBeNull()
  })
})

describe('buildAgentSessionContinuationPrompt with embedded transcript', () => {
  it('embeds decoded text instead of path guidance in focused mode', () => {
    const prompt = buildAgentSessionContinuationPrompt(sourceWith({}), 'focused', '**user**: hi')
    expect(prompt).toContain('**user**: hi')
    expect(prompt).not.toContain('available at this path')
  })

  it('keeps the complete-transcript path reference in full mode', () => {
    const prompt = buildAgentSessionContinuationPrompt(sourceWith({}), 'full', '**user**: hi')
    expect(prompt).toContain('**user**: hi')
    expect(prompt).toContain('/tmp/codex-session.jsonl')
  })

  it('leaves the raw-path flow untouched without embedded text', () => {
    const prompt = buildAgentSessionContinuationPrompt(sourceWith({}), 'focused', null)
    expect(prompt).toContain('available at this path')
  })
})
