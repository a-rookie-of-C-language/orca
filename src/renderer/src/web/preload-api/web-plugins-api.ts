import type { PreloadApi } from '../../../../preload/api-types'
import type {
  PluginPanelActionOutcome,
  PluginPanelEntry
} from '../../../../shared/plugins/plugin-panel-bridge'
import type { PluginConsentRequest } from '../../../../shared/plugins/plugin-consent-request'
import type { PluginHostListEntry } from '../../../../preload/api/plugin-host-api'
import { callRuntimeResult } from './web-runtime-calls'
import { noopUnsubscribe } from './web-storage'

/** Runtime-backed plugin operations shared by browser clients and Tauri. */
export function createWebPluginsApi(): NonNullable<Partial<PreloadApi>['plugins']> {
  return {
    list: () => callRuntimeResult<PluginHostListEntry[]>('plugins.list'),
    listLanguagePacks: () => callRuntimeResult('plugins.listLanguagePacks'),
    consent: (args: PluginConsentRequest) =>
      callRuntimeResult<PluginHostListEntry[]>('plugins.consent', args),
    setEnabled: (args) => callRuntimeResult<PluginHostListEntry[]>('plugins.setEnabled', args),
    readPanelEntry: (args: { pluginKey: string; panelId: string }) =>
      callRuntimeResult<PluginPanelEntry | null>('plugins.readPanelEntry', args),
    invokeCommand: (args: { pluginKey: string; commandId: string; args?: unknown }) =>
      callRuntimeResult('plugins.invokeCommand', args),
    panelAction: async (args: {
      sessionToken: string
      action: string
      params?: unknown
    }): Promise<PluginPanelActionOutcome> =>
      (await callRuntimeResult<{ outcome: PluginPanelActionOutcome }>('plugins.panelAction', args))
        .outcome,
    install: (source) => callRuntimeResult('plugins.install', source),
    listMarketplaces: () => callRuntimeResult('plugins.listMarketplaces'),
    addMarketplace: (source) => callRuntimeResult('plugins.addMarketplace', source),
    removeMarketplace: (args) => callRuntimeResult('plugins.removeMarketplace', args),
    refreshMarketplaces: (args = {}) => callRuntimeResult('plugins.refreshMarketplaces', args),
    listMarketplacePlugins: () => callRuntimeResult('plugins.listMarketplacePlugins'),
    previewMarketplacePlugin: (args) => callRuntimeResult('plugins.previewMarketplacePlugin', args),
    installMarketplacePlugin: (preview) =>
      callRuntimeResult('plugins.installMarketplacePlugin', preview),
    previewMarketplaceUpdate: (args) => callRuntimeResult('plugins.previewMarketplaceUpdate', args),
    rollbackMarketplacePlugin: (args) =>
      callRuntimeResult('plugins.rollbackMarketplacePlugin', args),
    remove: (args) => callRuntimeResult('plugins.remove', args),
    getLogs: (args) => callRuntimeResult('plugins.getLogs', args),
    refresh: () => callRuntimeResult<PluginHostListEntry[]>('plugins.list'),
    onChanged: () => noopUnsubscribe
  }
}
