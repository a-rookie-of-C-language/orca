// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearTauriBrowserClientRouteAuthority,
  deriveTauriBrowserClientPartition,
  noteTauriBrowserClientRouteAuthority,
  resolveTauriBrowserClientPartition
} from './tauri-native-browser-client-route-partition'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('./tauri-native-host', () => ({
  isTauriNativeHost: () => true,
  invokeNative: native.invoke,
  listenNative: () => () => {}
}))

beforeEach(() => {
  native.invoke.mockReset().mockResolvedValue(undefined)
})

describe('Tauri client-route partition resolution', () => {
  it('prefers the host-owned binding when available', async () => {
    native.invoke.mockResolvedValue({
      partition: 'persist:tauri-browser-v1-default-0123456789abcdef',
      bindingFingerprint: 'fingerprint-1'
    })
    await expect(resolveTauriBrowserClientPartition('env-1', 'default', 'native:1')).resolves.toBe(
      'persist:tauri-browser-v1-default-0123456789abcdef'
    )
    expect(native.invoke).toHaveBeenCalledWith(
      'poc_browser_client_route_resolve_partition',
      expect.objectContaining({
        args: { environmentId: 'env-1', profileId: 'default', executionHostKey: 'native:1' }
      })
    )
  })

  it('falls back to the renderer-local derivation without a native bridge', async () => {
    await expect(resolveTauriBrowserClientPartition('env-1', 'default', 'native:1')).resolves.toBe(
      deriveTauriBrowserClientPartition('default', 'native:1')
    )
  })

  it('ignores malformed native partitions', async () => {
    native.invoke.mockResolvedValue({ partition: 'not-a-partition' })
    await expect(resolveTauriBrowserClientPartition('env-1', 'default', 'native:1')).resolves.toBe(
      deriveTauriBrowserClientPartition('default', 'native:1')
    )
  })
})

describe('Tauri client-route authority reporting', () => {
  const authority = {
    authorityRuntimeId: 'runtime-1',
    authorityEpoch: 'epoch-1',
    browserHostClientId: 'host-1',
    browserHostGeneration: 3
  }

  it('notes and clears the host-owned lease without blocking', () => {
    noteTauriBrowserClientRouteAuthority('env-1', authority, 'native:1')
    expect(native.invoke).toHaveBeenCalledWith(
      'poc_browser_client_route_note_authority',
      expect.objectContaining({
        args: expect.objectContaining({ environmentId: 'env-1', executionHostKey: 'native:1' })
      })
    )
    clearTauriBrowserClientRouteAuthority('env-1')
    expect(native.invoke).toHaveBeenCalledWith(
      'poc_browser_client_route_close_authority',
      expect.objectContaining({ args: { environmentId: 'env-1' } })
    )
  })

  it('swallows native bridge failures', () => {
    native.invoke.mockRejectedValueOnce(new Error('gone'))
    expect(() => noteTauriBrowserClientRouteAuthority('env-1', authority, 'native:1')).not.toThrow()
    native.invoke.mockRejectedValueOnce(new Error('gone'))
    expect(() => clearTauriBrowserClientRouteAuthority('env-1')).not.toThrow()
  })
})
