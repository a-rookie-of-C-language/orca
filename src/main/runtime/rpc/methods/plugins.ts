import { defineMethod, type RpcContext } from '../core'
import type { PluginPanelEntry } from '../../../../shared/plugins/plugin-panel-bridge'
import { listPluginsForClients } from '../../../plugins/plugin-client-list'
import type { PluginListEntry } from '../../../plugins/plugin-list-projection'
import type { PluginService } from '../../../plugins/plugin-service'
import {
  pluginConsentRequestSchema,
  type PluginConsentRequest
} from '../../../../shared/plugins/plugin-consent-request'
import {
  PluginInstallParams,
  PluginLogsParams,
  PluginMarketplaceInstalledPluginParams,
  PluginMarketplaceInstallParams,
  PluginMarketplacePluginParams,
  PluginMarketplaceRefreshParams,
  PluginMarketplaceSourceIdParams,
  PluginMarketplaceSourceParams,
  PluginRemoveParams,
  PluginInvokeCommandParams,
  PluginReadPanelEntryParams,
  PluginSetEnabledParams,
  PluginsPanelActionParams
} from '../../../../shared/rpc-contract/plugins-params'
import type {
  PluginHostInstallResult,
  PluginHostInstallSource,
  PluginHostListEntry,
  PluginHostLogLine,
  PluginMarketplaceHostInstallPreview,
  PluginMarketplaceHostListing,
  PluginMarketplaceHostSourceState
} from '../../../../preload/api/plugin-host-api'
import type { PluginMarketplaceGitSource } from '../../../../shared/plugins/plugin-marketplace'

export type PluginManagementForRpc = {
  install: (source: PluginHostInstallSource) => Promise<PluginHostInstallResult>
  remove: (pluginKey: string) => Promise<PluginHostListEntry[]>
  getLogs: (pluginKey: string) => Promise<PluginHostLogLine[]>
  listMarketplaces: () => Promise<PluginMarketplaceHostSourceState[]>
  addMarketplace: (source: PluginMarketplaceGitSource) => Promise<PluginMarketplaceHostSourceState>
  removeMarketplace: (sourceId: string) => Promise<PluginMarketplaceHostSourceState[]>
  refreshMarketplaces: (sourceId?: string) => Promise<PluginMarketplaceHostSourceState[]>
  listMarketplacePlugins: () => Promise<PluginMarketplaceHostListing[]>
  previewMarketplacePlugin: (
    marketplaceSourceId: string,
    pluginKey: string
  ) => Promise<PluginMarketplaceHostInstallPreview>
  installMarketplacePlugin: (preview: {
    marketplaceSourceId: string
    marketplaceCommit: string
    pluginKey: string
    resolvedCommit: string
  }) => Promise<PluginHostInstallResult>
  previewMarketplaceUpdate: (pluginKey: string) => Promise<PluginMarketplaceHostInstallPreview>
  rollbackMarketplacePlugin: (pluginKey: string) => Promise<PluginHostInstallResult>
}

/** Expose desktop IPC's plugin consent/actions over serve/headless RPC through the same PluginService permission boundary. */

// Inject the separate composition-root PluginService without widening shared RpcContext.
let pluginServiceForRpc: PluginService | null = null
// Consent/enablement need the settings Store too, so the entry injects bound
// closures instead of the store itself.
let pluginConsentForRpc: ((request: PluginConsentRequest) => Promise<void>) | null = null
let pluginEnablementForRpc: ((pluginKey: string, enabled: boolean) => Promise<void>) | null = null
let pluginManagementForRpc: PluginManagementForRpc | null = null

export function setPluginServiceForRpc(
  service: PluginService | null,
  writes?: {
    applyConsent: (request: PluginConsentRequest) => Promise<void>
    applyEnablement: (pluginKey: string, enabled: boolean) => Promise<void>
  },
  management?: PluginManagementForRpc
): void {
  pluginServiceForRpc = service
  pluginConsentForRpc = writes?.applyConsent ?? null
  pluginEnablementForRpc = writes?.applyEnablement ?? null
  pluginManagementForRpc = management ?? null
}

function requirePluginService(): PluginService {
  if (!pluginServiceForRpc) {
    throw new Error('Plugin service is not available on this runtime')
  }
  return pluginServiceForRpc
}

async function listForRpc(): Promise<PluginListEntry[]> {
  return listPluginsForClients(requirePluginService())
}

function rpcPanelOwner(context: RpcContext): string {
  // Bind bearer sessions to individual paired connections, even for sibling sockets of one device.
  return `runtime:${context.connectionId ?? context.clientId ?? 'local'}`
}

function bindRpcPanelOwner(service: PluginService, context: RpcContext): string {
  const ownerKey = rpcPanelOwner(context)
  service.panels.bindOwnerSignal(ownerKey, context.signal)
  return ownerKey
}

export const PLUGIN_METHODS = [
  defineMethod({
    name: 'plugins.list',
    permission: 'workspace',
    params: null,
    handler: async () => listForRpc()
  }),
  defineMethod({
    name: 'plugins.listLanguagePacks',
    permission: 'workspace',
    params: null,
    handler: async () => {
      const service = requirePluginService()
      await service.whenReady()
      return service.contentPacks.languagePacks.list()
    }
  }),
  defineMethod({
    name: 'plugins.install',
    permission: 'host-admin',
    params: PluginInstallParams,
    handler: async (params) => {
      if (!pluginManagementForRpc) {
        throw new Error('Plugin installation is not available on this runtime')
      }
      return pluginManagementForRpc.install(params)
    }
  }),
  defineMethod({
    // Why: headless serve has no consent dialog — an explicit consent call is
    // the only way a pending plugin becomes active on a server.
    name: 'plugins.consent',
    permission: 'host-admin',
    params: pluginConsentRequestSchema,
    handler: async (params) => {
      const service = requirePluginService()
      await service.whenReady()
      if (!pluginConsentForRpc) {
        throw new Error('Plugin consent is not available on this runtime')
      }
      await pluginConsentForRpc(params)
      return listForRpc()
    }
  }),
  defineMethod({
    name: 'plugins.setEnabled',
    permission: 'host-admin',
    params: PluginSetEnabledParams,
    handler: async (params) => {
      const service = requirePluginService()
      await service.whenReady()
      if (!pluginEnablementForRpc) {
        throw new Error('Plugin enablement is not available on this runtime')
      }
      await pluginEnablementForRpc(params.pluginKey, params.enabled)
      return listForRpc()
    }
  }),
  defineMethod({
    // Enforce panel capabilities here too because headless clients relay bridge calls over RPC.
    name: 'plugins.panelAction',
    permission: 'host-admin',
    // Apply raw admission before strict parsing so malformed/oversize traffic still consumes panel budget.
    params: PluginsPanelActionParams,
    handler: async (params, context) => {
      const service = requirePluginService()
      await service.whenReady()
      return {
        outcome: await service.panels.execute(bindRpcPanelOwner(service, context), params)
      }
    }
  }),
  defineMethod({
    name: 'plugins.readPanelEntry',
    permission: 'workspace',
    params: PluginReadPanelEntryParams,
    handler: async (params, context): Promise<PluginPanelEntry | null> => {
      const service = requirePluginService()
      await service.whenReady()
      const ownerKey = bindRpcPanelOwner(service, context)
      const entry = await service.panels.open(ownerKey, params.pluginKey, params.panelId)
      if (context.signal?.aborted) {
        service.panels.revokeOwner(ownerKey)
        return null
      }
      return entry
    }
  }),
  defineMethod({
    name: 'plugins.invokeCommand',
    permission: 'host-admin',
    params: PluginInvokeCommandParams,
    handler: async (params) => {
      const service = requirePluginService()
      await service.whenReady()
      return service.invokeCommand(params.pluginKey, params.commandId, params.args)
    }
  }),
  defineMethod({
    name: 'plugins.remove',
    permission: 'host-admin',
    params: PluginRemoveParams,
    handler: async (params) => {
      if (!pluginManagementForRpc) {
        throw new Error('Plugin removal is not available on this runtime')
      }
      return pluginManagementForRpc.remove(params.pluginKey)
    }
  }),
  defineMethod({
    name: 'plugins.getLogs',
    permission: 'workspace',
    params: PluginLogsParams,
    handler: async (params) => {
      if (!pluginManagementForRpc) {
        throw new Error('Plugin logs are not available on this runtime')
      }
      return pluginManagementForRpc.getLogs(params.pluginKey)
    }
  }),
  defineMethod({
    name: 'plugins.listMarketplaces',
    permission: 'workspace',
    params: null,
    handler: async () => {
      if (!pluginManagementForRpc) {
        throw new Error('Plugin marketplaces are not available on this runtime')
      }
      return pluginManagementForRpc.listMarketplaces()
    }
  }),
  defineMethod({
    name: 'plugins.addMarketplace',
    permission: 'host-admin',
    params: PluginMarketplaceSourceParams,
    handler: async (params) => {
      if (!pluginManagementForRpc) {
        throw new Error('Plugin marketplaces are not available on this runtime')
      }
      return pluginManagementForRpc.addMarketplace(params)
    }
  }),
  defineMethod({
    name: 'plugins.removeMarketplace',
    permission: 'host-admin',
    params: PluginMarketplaceSourceIdParams,
    handler: async (params) => {
      if (!pluginManagementForRpc) {
        throw new Error('Plugin marketplaces are not available on this runtime')
      }
      return pluginManagementForRpc.removeMarketplace(params.sourceId)
    }
  }),
  defineMethod({
    name: 'plugins.refreshMarketplaces',
    permission: 'host-admin',
    params: PluginMarketplaceRefreshParams,
    handler: async (params) => {
      if (!pluginManagementForRpc) {
        throw new Error('Plugin marketplaces are not available on this runtime')
      }
      return pluginManagementForRpc.refreshMarketplaces(params.sourceId)
    }
  }),
  defineMethod({
    name: 'plugins.listMarketplacePlugins',
    permission: 'workspace',
    params: null,
    handler: async () => {
      if (!pluginManagementForRpc) {
        throw new Error('Plugin marketplaces are not available on this runtime')
      }
      return pluginManagementForRpc.listMarketplacePlugins()
    }
  }),
  defineMethod({
    name: 'plugins.previewMarketplacePlugin',
    permission: 'workspace',
    params: PluginMarketplacePluginParams,
    handler: async (params) => {
      if (!pluginManagementForRpc) {
        throw new Error('Plugin marketplaces are not available on this runtime')
      }
      return pluginManagementForRpc.previewMarketplacePlugin(
        params.marketplaceSourceId,
        params.pluginKey
      )
    }
  }),
  defineMethod({
    name: 'plugins.installMarketplacePlugin',
    permission: 'host-admin',
    params: PluginMarketplaceInstallParams,
    handler: async (params) => {
      if (!pluginManagementForRpc) {
        throw new Error('Plugin marketplaces are not available on this runtime')
      }
      return pluginManagementForRpc.installMarketplacePlugin(params)
    }
  }),
  defineMethod({
    name: 'plugins.previewMarketplaceUpdate',
    permission: 'workspace',
    params: PluginMarketplaceInstalledPluginParams,
    handler: async (params) => {
      if (!pluginManagementForRpc) {
        throw new Error('Plugin marketplaces are not available on this runtime')
      }
      return pluginManagementForRpc.previewMarketplaceUpdate(params.pluginKey)
    }
  }),
  defineMethod({
    name: 'plugins.rollbackMarketplacePlugin',
    permission: 'host-admin',
    params: PluginMarketplaceInstalledPluginParams,
    handler: async (params) => {
      if (!pluginManagementForRpc) {
        throw new Error('Plugin marketplaces are not available on this runtime')
      }
      return pluginManagementForRpc.rollbackMarketplacePlugin(params.pluginKey)
    }
  })
]
