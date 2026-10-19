import {
  connectRegisteredSshTarget,
  disconnectRegisteredSshTarget,
  getRegisteredSshState,
  getRegisteredSshTargetMutations,
  getSshConnectionManager,
  importRegisteredSshConfig,
  listRegisteredRemovedSshTargetLabels,
  listRegisteredSuppressedSshConfigAliases,
  listRegisteredSshTargets
} from '../../../ssh/ssh-target-registry'
import { isManagedOrcadSshTarget } from '../../../ssh/ssh-connection-store'
import { browseSshDirectory } from '../../../ssh/ssh-remote-directory-browse'
import {
  listUserSshConfigHostSummaries,
  resolveUserSshConfigHost
} from '../../../ssh/ssh-config-host-picker'
import { defineMethod } from '../core'
import { getPublicSshError, getPublicSshState } from '../../public-ssh-state'
import type {
  SshExternalEditorAuthorityResult,
  SshTarget as SshTargetRecord,
  SshTargetSummary
} from '../../../../shared/ssh-types'
import type {
  SshEditableTarget,
  SshEditableTargetField,
  SshEditableTargetInput
} from '../../../../shared/ssh-target-management'
import {
  SshBrowseDir,
  SshFolderDownload,
  SshFileReadChunk,
  SshConfigHostList,
  SshConnect,
  SshTarget,
  SshImportConfig,
  SshResolveConfigHost,
  SshResolveExternalEditorAuthority,
  SshTargetAdd,
  SshTargetUpdate,
  SshSubmitCredential
} from '../../../../shared/rpc-contract/ssh-params'
import { submitSshRuntimeCredential } from '../../../ssh/ssh-runtime-credential-bridge'
import { resolveVsCodeSshAuthority } from '../../../ssh/vscode-ssh-authority'
import { SSH_PORT_FORWARD_METHODS } from './ssh-port-forwards'
import { SSH_NEEDS_PASSPHRASE_METHODS } from './ssh-needs-passphrase'
import { SSH_TEST_CONNECTION_METHODS } from './ssh-test-connection'

// Why: `generation` stays optional on the wire — an old server simply omits it and its rows key on target id alone.
function toSshTargetSummary({ id, label, generation }: SshTargetRecord): SshTargetSummary {
  const state = getRegisteredSshState(id)
  const remotePlatform = state?.remotePlatform
  return {
    id,
    label,
    ...(generation === undefined ? {} : { generation }),
    connected: state?.status === 'connected',
    ...(state?.status === undefined ? {} : { connectionStatus: state.status }),
    ...(remotePlatform === undefined ? {} : { remotePlatform })
  }
}

function listRegisteredSshTargetSummaries(): SshTargetSummary[] {
  return listRegisteredSshTargets().map(toSshTargetSummary)
}

// Why an allowlist: a field added to SshTarget later (or a stray key in an old profile) must not
// reach paired clients by default. `satisfies` keeps it in step with SSH_EDITABLE_TARGET_FIELDS.
function pickSshEditableFields(source: SshEditableTargetInput): SshEditableTargetInput {
  return {
    label: source.label,
    configHost: source.configHost,
    host: source.host,
    port: source.port,
    username: source.username,
    identityFile: source.identityFile,
    identityAgent: source.identityAgent,
    identitiesOnly: source.identitiesOnly,
    gssapiAuthentication: source.gssapiAuthentication,
    proxyCommand: source.proxyCommand,
    jumpHost: source.jumpHost,
    relayGracePeriodSeconds: source.relayGracePeriodSeconds,
    systemSshConnectionReuse: source.systemSshConnectionReuse,
    remoteRuntime: source.remoteRuntime,
    allowRemoteCliControl: source.allowRemoteCliControl
  } satisfies Record<SshEditableTargetField, unknown>
}

function toSshEditableTarget(target: SshTargetRecord): SshEditableTarget {
  return {
    ...pickSshEditableFields(target),
    ...toSshTargetSummary(target),
    ...(target.source === undefined ? {} : { source: target.source }),
    ...(isManagedOrcadSshTarget(target) ? { managedServer: true as const } : {})
  }
}

export const SSH_METHODS = [
  defineMethod({
    name: 'ssh.getState',
    permission: 'workspace',
    params: SshTarget,
    handler: (params) => ({
      state: getPublicSshState(getRegisteredSshState(params.targetId) ?? null)
    })
  }),
  defineMethod({
    name: 'ssh.connect',
    permission: 'host-admin',
    params: SshConnect,
    handler: async (params) => {
      try {
        const state = await connectRegisteredSshTarget(params.targetId, {
          automatic: params.automatic === true
        })
        return { state: getPublicSshState(state) }
      } catch {
        const state = getRegisteredSshState(params.targetId)
        throw new Error(getPublicSshError(state?.status ?? 'error'))
      }
    }
  }),
  defineMethod({
    name: 'ssh.disconnect',
    permission: 'host-admin',
    params: SshTarget,
    handler: async (params) => {
      await disconnectRegisteredSshTarget(params.targetId)
      return { disconnected: true }
    }
  }),
  defineMethod({
    name: 'ssh.submitCredential',
    permission: 'host-admin',
    params: SshSubmitCredential,
    handler: (params) => ({ submitted: submitSshRuntimeCredential(params.requestId, params.value) })
  }),
  defineMethod({
    name: 'ssh.listTargets',
    permission: 'workspace',
    params: null,
    // Why: legacy clients can call this method directly, so it must preserve the same HUB-private secret boundary.
    handler: () => ({ targets: listRegisteredSshTargetSummaries() })
  }),
  defineMethod({
    name: 'ssh.listTargetSummaries',
    permission: 'workspace',
    params: null,
    // Why: paired clients need display identity only; SSH addresses, jump chains, and credentials remain HUB-private.
    handler: () => ({ targets: listRegisteredSshTargetSummaries() })
  }),
  defineMethod({
    name: 'ssh.listRemovedTargetLabels',
    permission: 'workspace',
    params: null,
    handler: () => ({ labels: listRegisteredRemovedSshTargetLabels() })
  }),
  // Why `workspace`: a paired client that can open terminals here can already edit ~/.ssh/config,
  // so managing this host's SSH targets is the same power (rpc-method-permission.ts).
  defineMethod({
    name: 'ssh.listEditableTargets',
    permission: 'workspace',
    params: null,
    handler: () => ({ targets: listRegisteredSshTargets().map(toSshEditableTarget) })
  }),
  defineMethod({
    name: 'ssh.importConfig',
    permission: 'workspace',
    params: SshImportConfig,
    handler: (params) => importRegisteredSshConfig(params)
  }),
  defineMethod({
    name: 'ssh.listConfigHosts',
    permission: 'workspace',
    params: SshConfigHostList,
    handler: (params) =>
      listUserSshConfigHostSummaries(
        listRegisteredSshTargets(),
        params.query,
        listRegisteredSuppressedSshConfigAliases(),
        { refresh: params.refresh === true }
      )
  }),
  defineMethod({
    name: 'ssh.resolveConfigHost',
    permission: 'workspace',
    params: SshResolveConfigHost,
    handler: (params) => resolveUserSshConfigHost(params.alias)
  }),
  defineMethod({
    name: 'ssh.resolveExternalEditorAuthority',
    permission: 'workspace',
    params: SshResolveExternalEditorAuthority,
    handler: (params): SshExternalEditorAuthorityResult => {
      const target = listRegisteredSshTargets().find(
        (candidate) => candidate.id === params.targetId
      )
      if (!target) {
        return { ok: false, reason: 'ssh-target-not-found' }
      }
      if (target.owner?.type === 'on-demand-runtime') {
        return { ok: false, reason: 'remote-runtime-unsupported' }
      }
      return resolveVsCodeSshAuthority(target)
    }
  }),
  defineMethod({
    name: 'ssh.addTarget',
    permission: 'workspace',
    params: SshTargetAdd,
    handler: (params) => {
      const result = getRegisteredSshTargetMutations().add({ ...params.target, source: 'manual' })
      return {
        target: toSshEditableTarget(result.target),
        repoReadoptions: result.repoReadoptions
      }
    }
  }),
  defineMethod({
    name: 'ssh.updateTarget',
    permission: 'workspace',
    params: SshTargetUpdate,
    handler: (params) => {
      // Why: replace semantics, so an omitted optional field is cleared, as SSH settings do.
      const updated = getRegisteredSshTargetMutations().update(params.targetId, {
        ...pickSshEditableFields(params.target),
        source: 'manual'
      })
      if (!updated) {
        throw new Error(`SSH target not found: ${params.targetId}`)
      }
      return { target: toSshEditableTarget(updated) }
    }
  }),
  defineMethod({
    name: 'ssh.removeTarget',
    permission: 'workspace',
    params: SshTarget,
    handler: async (params) => {
      await getRegisteredSshTargetMutations().remove(params.targetId)
      return { removed: true }
    }
  }),
  defineMethod({
    name: 'ssh.browseDir',
    permission: 'workspace',
    params: SshBrowseDir,
    handler: (params) =>
      browseSshDirectory(getSshConnectionManager(), params.targetId, params.dirPath)
  }),
  defineMethod({
    name: 'ssh.readFileChunk',
    permission: 'workspace',
    params: SshFileReadChunk,
    handler: async (params) => {
      const target = listRegisteredSshTargets().find(
        (candidate) => candidate.id === params.targetId
      )
      const manager = getSshConnectionManager()
      const connection = manager?.getConnection(params.targetId)
      if (!target || !manager || !connection) {
        throw new Error(`SSH connection "${params.targetId}" not found`)
      }
      if (
        params.expectedGeneration !== undefined &&
        target.generation !== params.expectedGeneration
      ) {
        throw new Error('SSH target changed while reading the file')
      }
      return connection.readFileChunk(params.filePath, params.offset, params.length)
    }
  }),
  defineMethod({
    name: 'ssh.downloadFolder',
    permission: 'workspace',
    params: SshFolderDownload,
    handler: async (params) => {
      const target = listRegisteredSshTargets().find(
        (candidate) => candidate.id === params.targetId
      )
      const manager = getSshConnectionManager()
      const connection = manager?.getConnection(params.targetId)
      if (!target || !manager || !connection) {
        throw new Error(`SSH connection "${params.targetId}" not found`)
      }
      if (
        params.expectedGeneration !== undefined &&
        target.generation !== params.expectedGeneration
      ) {
        throw new Error('SSH target changed while downloading the folder')
      }
      await connection.downloadFolder(params.dirPath, params.destinationPath)
      return { destinationPath: params.destinationPath }
    }
  }),
  ...SSH_PORT_FORWARD_METHODS,
  ...SSH_NEEDS_PASSPHRASE_METHODS,
  ...SSH_TEST_CONNECTION_METHODS
]
