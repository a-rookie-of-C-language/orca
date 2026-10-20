import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { eraseRpcMethods, isStreamingMethod } from '../core'
import { TAURI_DESKTOP_ACCOUNT_CONTROL_RUNTIME_CAPABILITY } from '../../../../shared/account-runtime-capabilities'
import { CREDENTIAL_METHODS } from './credentials'

function method(name: string) {
  const found = eraseRpcMethods(CREDENTIAL_METHODS).find((candidate) => candidate.name === name)
  if (!found) {
    throw new Error(`Missing method ${name}`)
  }
  if (isStreamingMethod(found)) {
    throw new Error(`${name} must be a request method`)
  }
  return found
}

describe('credential RPC methods', () => {
  it('keeps credential mutations behind the Tauri desktop capability', async () => {
    const saveMiniMaxApiKey = vi.fn().mockReturnValue({ apiKeyConfigured: true })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this handler only calls the stubbed credential writer.
    const runtime = { saveMiniMaxApiKey } as unknown as OrcaRuntimeService
    const save = method('credentials.saveMiniMaxApiKey')

    await expect(
      save.handler({ value: 'secret-value' }, { runtime, clientKind: 'runtime' })
    ).rejects.toThrow(/local Orca desktop/)
    expect(saveMiniMaxApiKey).not.toHaveBeenCalled()

    await expect(
      save.handler(
        { value: 'secret-value' },
        {
          runtime,
          clientKind: 'runtime',
          clientCapabilities: [TAURI_DESKTOP_ACCOUNT_CONTROL_RUNTIME_CAPABILITY]
        }
      )
    ).resolves.toEqual({ apiKeyConfigured: true })
    expect(saveMiniMaxApiKey).toHaveBeenCalledWith('secret-value')
  })

  it('validates the value envelope before reaching the credential store', () => {
    const save = method('credentials.saveOpenCodeGoApiKey')
    expect(save.params?.parse({ value: 'key' })).toEqual({ value: 'key' })
    expect(() => save.params?.parse({ value: 42 })).toThrow()
    expect(() => save.params?.parse({ value: 'key', extra: true })).toThrow()
  })

  it('allows read-only status calls for paired clients', async () => {
    const getGrokAccountStatus = vi.fn().mockReturnValue({ signedIn: false })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this status handler only calls the stubbed Grok reader.
    const runtime = { getGrokAccountStatus } as unknown as OrcaRuntimeService
    await expect(
      method('credentials.getGrokStatus').handler(undefined, { runtime, clientKind: 'runtime' })
    ).resolves.toEqual({ signedIn: false })
    expect(getGrokAccountStatus).toHaveBeenCalledOnce()
  })
})
