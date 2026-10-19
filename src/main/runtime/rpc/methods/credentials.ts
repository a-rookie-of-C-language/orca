import { defineMethod } from '../core'
import { CredentialValueParams } from '../../../../shared/rpc-contract/credential-params'
import { TAURI_DESKTOP_ACCOUNT_CONTROL_RUNTIME_CAPABILITY } from '../../../../shared/account-runtime-capabilities'

function assertTauriDesktopControl(
  clientKind: 'mobile' | 'runtime' | undefined,
  clientCapabilities: readonly string[] | undefined
): void {
  if (
    clientKind !== undefined &&
    !clientCapabilities?.includes(TAURI_DESKTOP_ACCOUNT_CONTROL_RUNTIME_CAPABILITY)
  ) {
    throw new Error('Credential changes are only available on the local Orca desktop.')
  }
}

export const CREDENTIAL_METHODS = [
  defineMethod({
    name: 'credentials.getMiniMaxStatus',
    permission: 'workspace',
    params: null,
    handler: async (_, { runtime }) => runtime.getMiniMaxCredentialsStatus()
  }),
  defineMethod({
    name: 'credentials.saveMiniMaxCookie',
    permission: 'accounts-admin',
    params: CredentialValueParams,
    handler: async (params, { runtime, clientKind, clientCapabilities }) => {
      assertTauriDesktopControl(clientKind, clientCapabilities)
      return runtime.saveMiniMaxCookie(params.value)
    }
  }),
  defineMethod({
    name: 'credentials.clearMiniMaxCookie',
    permission: 'accounts-admin',
    params: null,
    handler: async (_, { runtime, clientKind, clientCapabilities }) => {
      assertTauriDesktopControl(clientKind, clientCapabilities)
      return runtime.clearMiniMaxCookie()
    }
  }),
  defineMethod({
    name: 'credentials.saveMiniMaxApiKey',
    permission: 'accounts-admin',
    params: CredentialValueParams,
    handler: async (params, { runtime, clientKind, clientCapabilities }) => {
      assertTauriDesktopControl(clientKind, clientCapabilities)
      return runtime.saveMiniMaxApiKey(params.value)
    }
  }),
  defineMethod({
    name: 'credentials.clearMiniMaxApiKey',
    permission: 'accounts-admin',
    params: null,
    handler: async (_, { runtime, clientKind, clientCapabilities }) => {
      assertTauriDesktopControl(clientKind, clientCapabilities)
      return runtime.clearMiniMaxApiKey()
    }
  }),
  defineMethod({
    name: 'credentials.getZcodePlanStatus',
    permission: 'workspace',
    params: null,
    handler: async (_, { runtime }) => runtime.getZcodePlanCredentialsStatus()
  }),
  defineMethod({
    name: 'credentials.saveZcodePlanApiKey',
    permission: 'accounts-admin',
    params: CredentialValueParams,
    handler: async (params, { runtime, clientKind, clientCapabilities }) => {
      assertTauriDesktopControl(clientKind, clientCapabilities)
      return runtime.saveZcodePlanApiKey(params.value)
    }
  }),
  defineMethod({
    name: 'credentials.clearZcodePlanApiKey',
    permission: 'accounts-admin',
    params: null,
    handler: async (_, { runtime, clientKind, clientCapabilities }) => {
      assertTauriDesktopControl(clientKind, clientCapabilities)
      return runtime.clearZcodePlanApiKey()
    }
  }),
  defineMethod({
    name: 'credentials.getOpenCodeGoStatus',
    permission: 'workspace',
    params: null,
    handler: async (_, { runtime }) => runtime.getOpenCodeGoCredentialsStatus()
  }),
  defineMethod({
    name: 'credentials.saveOpenCodeGoApiKey',
    permission: 'accounts-admin',
    params: CredentialValueParams,
    handler: async (params, { runtime, clientKind, clientCapabilities }) => {
      assertTauriDesktopControl(clientKind, clientCapabilities)
      return runtime.saveOpenCodeGoApiKey(params.value)
    }
  }),
  defineMethod({
    name: 'credentials.clearOpenCodeGoApiKey',
    permission: 'accounts-admin',
    params: null,
    handler: async (_, { runtime, clientKind, clientCapabilities }) => {
      assertTauriDesktopControl(clientKind, clientCapabilities)
      return runtime.clearOpenCodeGoApiKey()
    }
  }),
  defineMethod({
    name: 'credentials.getCursorStatus',
    permission: 'workspace',
    params: null,
    handler: async (_, { runtime }) => runtime.getCursorAccountStatus()
  }),
  defineMethod({
    name: 'credentials.getGrokStatus',
    permission: 'workspace',
    params: null,
    handler: async (_, { runtime }) => runtime.getGrokAccountStatus()
  })
]
