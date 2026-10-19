import { getAppEnvironment } from '../../shared/app-environment'
import {
  normalizePluginConsents,
  normalizePluginIdList
} from '../../shared/plugins/plugin-consent-state'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { Store } from '../persistence'
import { applyPluginConsent, applyPluginEnablement } from '../plugins/plugin-enablement'
import { getPluginsDataDir, getUserPluginsDir } from '../plugins/plugin-discovery'
import { PluginKillListService } from '../plugins/plugin-kill-list-service'
import {
  installPluginFromGit,
  installPluginFromLocalPath,
  readPluginLockfile,
  removeInstalledPlugin
} from '../plugins/plugin-install'
import { PluginMarketplaceInstaller } from '../plugins/plugin-marketplace-installer'
import { PluginMarketplaceService } from '../plugins/plugin-marketplace-service'
import { resolvePluginHostEntryPath } from '../plugins/plugin-host-process'
import { PluginService } from '../plugins/plugin-service'
import { canRemoveInstalledPlugin } from '../plugins/plugin-runtime-management'
import { setPluginServiceForRpc, type PluginManagementForRpc } from '../runtime/rpc/methods/plugins'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'

export type OrcadPluginStartup = {
  service: PluginService
  marketplace: PluginMarketplaceService
  installer: PluginMarketplaceInstaller
}

/** Installs the Node-only plugin composition root used by Tauri's local runtime. */
export async function startOrcadPlugins(input: {
  runtime: OrcaRuntimeService
  store: Store
  userDataPath: string
  registerCleanup: (cleanup: OrcadRuntimeCleanup) => void
}): Promise<OrcadPluginStartup> {
  const { runtime, store, userDataPath, registerCleanup } = input
  const environment = getAppEnvironment()
  const killList = new PluginKillListService({
    pluginsDataDir: getPluginsDataDir(userDataPath)
  })
  await killList.initialize()

  const marketplace = new PluginMarketplaceService({
    pluginsDataDir: getPluginsDataDir(userDataPath),
    getKillListEntry: (pluginKey) => killList.find(pluginKey)
  })
  const installer = new PluginMarketplaceInstaller({
    marketplace,
    userDataPath,
    hostVersion: environment.getVersion(),
    blockedPluginReason: (pluginKey) => killList.reason(pluginKey)
  })
  const service = new PluginService({
    userDataPath,
    hostVersion: environment.getVersion(),
    isPluginSystemEnabled: () => store.getSettings().pluginSystemEnabled === true,
    getDisabledPlugins: () => normalizePluginIdList(store.getSettings().disabledPlugins),
    getPluginConsents: () => normalizePluginConsents(store.getSettings().pluginConsents),
    getDevPluginPaths: () => normalizePluginIdList(store.getSettings().devPluginPaths),
    getPluginKillListEntry: (pluginKey) => killList.find(pluginKey),
    hostEntryPath: resolvePluginHostEntryPath(environment.getAppPath(), environment.isPackaged())
  })
  service.setRuntimeDelegate(runtime)

  const listPlugins = async () => {
    const { listPluginsForClients } = await import('../plugins/plugin-client-list')
    return listPluginsForClients(service)
  }
  const management: PluginManagementForRpc = {
    install: async (source) => {
      const pluginsDir = getUserPluginsDir(userDataPath)
      const blockedPluginReason = (pluginKey: string): string | null => killList.reason(pluginKey)
      const result =
        source.kind === 'local-path'
          ? await installPluginFromLocalPath({
              pluginsDir,
              sourcePath: source.path,
              hostVersion: environment.getVersion(),
              blockedPluginReason
            })
          : await installPluginFromGit({
              pluginsDir,
              url: source.url,
              ref: source.ref,
              hostVersion: environment.getVersion(),
              blockedPluginReason
            })
      if (result.ok) {
        await service.refresh()
      }
      return result
    },
    remove: async (pluginKey) => {
      await service.whenReady()
      const pluginsDir = getUserPluginsDir(userDataPath)
      const lock = await readPluginLockfile(pluginsDir)
      if (!canRemoveInstalledPlugin(service, pluginKey, lock)) {
        throw new Error(`cannot remove protected or non-installed plugin ${pluginKey}`)
      }
      await service.removePlugin(pluginKey, () =>
        removeInstalledPlugin({
          pluginsDir,
          pluginsDataDir: getPluginsDataDir(userDataPath),
          pluginKey
        })
      )
      const settings = store.getSettings()
      const consents = { ...settings.pluginConsents }
      delete consents[pluginKey]
      const disabledPlugins = normalizePluginIdList(settings.disabledPlugins).filter(
        (entry) => entry !== pluginKey
      )
      store.updateSettings({ pluginConsents: consents, disabledPlugins }, { notifyListeners: true })
      await service.refresh()
      return listPlugins()
    },
    getLogs: async (pluginKey) => {
      await service.whenReady()
      return service.getLogs(pluginKey)
    },
    listMarketplaces: () => marketplace.listSources(),
    addMarketplace: (source) => marketplace.addSource(source),
    removeMarketplace: async (sourceId) => {
      await marketplace.removeSource(sourceId)
      return marketplace.listSources()
    },
    refreshMarketplaces: async (sourceId) =>
      sourceId ? [await marketplace.refreshSource(sourceId)] : marketplace.refreshAll(),
    listMarketplacePlugins: () => marketplace.listPlugins(),
    previewMarketplacePlugin: (sourceId, pluginKey) => installer.preview(sourceId, pluginKey),
    installMarketplacePlugin: async (preview) => {
      const result = await installer.install(preview)
      if (result.ok) {
        await service.refresh()
      }
      return result
    },
    previewMarketplaceUpdate: (pluginKey) => installer.previewInstalledUpdate(pluginKey),
    rollbackMarketplacePlugin: async (pluginKey) => {
      await service.deactivatePlugin(pluginKey)
      const result = await installer.rollback(pluginKey)
      if (result.ok) {
        await service.refresh()
      }
      return result
    }
  }

  setPluginServiceForRpc(
    service,
    {
      applyConsent: (request) => applyPluginConsent({ store, pluginService: service, ...request }),
      applyEnablement: (pluginKey, enabled) =>
        applyPluginEnablement({ store, pluginService: service, pluginKey, enabled })
    },
    management
  )

  const unsubscribeSettings = store.onSettingsChanged((updates) => {
    if ('pluginSystemEnabled' in updates || 'devPluginPaths' in updates) {
      void service.refresh().catch((error: unknown) => {
        console.warn('[plugins] failed to apply runtime settings change:', error)
      })
    }
  })
  const unsubscribeKillList = killList.onChanged(() => {
    void service.reconcileActivationState().catch((error: unknown) => {
      console.warn('[plugins] failed to apply runtime safety-list refresh:', error)
    })
  })
  registerCleanup(() => service.dispose())
  registerCleanup(() => unsubscribeKillList())
  registerCleanup(() => unsubscribeSettings())
  registerCleanup(() => setPluginServiceForRpc(null))

  const unsubscribeLifecycle = runtime.onWorktreeLifecycle((event) => {
    service.emitEvent(
      event.kind === 'created' ? 'worktree.created' : 'worktree.removed',
      event.kind === 'created'
        ? { worktreeId: event.worktreeId, path: event.path, branch: event.branch }
        : { worktreeId: event.worktreeId, path: event.path }
    )
  })
  registerCleanup(() => unsubscribeLifecycle())

  await service.initialize()
  if (store.getSettings().pluginSystemEnabled === true) {
    void marketplace.seedOfficialSource().catch((error: unknown) => {
      console.warn('[plugins] failed to configure the official marketplace:', error)
    })
  }
  return { service, marketplace, installer }
}
