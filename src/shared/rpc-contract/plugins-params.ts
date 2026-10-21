import { z } from 'zod'
import { isQualifiedPluginKey } from '../plugins/plugin-manifest'
import { isAllowedPluginGitUrl, PLUGIN_COMMIT_PATTERN } from '../plugins/plugin-install-lockfile'
import { pluginMarketplaceGitSourceSchema } from '../plugins/plugin-marketplace'

const pluginGitUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(32 * 1024)
  .refine(isAllowedPluginGitUrl, 'git URL must use HTTPS or SSH')

export const PluginInstallParams = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('local-path'),
    path: z
      .string()
      .min(1)
      .max(32 * 1024)
  }),
  z.strictObject({
    kind: z.literal('git'),
    url: pluginGitUrlSchema,
    ref: z.string().trim().min(1).max(4_096)
  })
])

export const PluginRemoveParams = z.strictObject({
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key')
})

export const PluginLogsParams = z.strictObject({ pluginKey: z.string().min(1) })

export const PluginMarketplaceSourceParams = pluginMarketplaceGitSourceSchema

export const PluginMarketplaceSourceIdParams = z.strictObject({ sourceId: z.string().min(1) })

export const PluginMarketplaceRefreshParams = PluginMarketplaceSourceIdParams.partial()

export const PluginMarketplacePluginParams = z.strictObject({
  marketplaceSourceId: z.string().min(1),
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key')
})

export const PluginMarketplaceInstallParams = PluginMarketplacePluginParams.extend({
  marketplaceCommit: z.string().regex(PLUGIN_COMMIT_PATTERN),
  resolvedCommit: z.string().regex(PLUGIN_COMMIT_PATTERN)
})

export const PluginMarketplaceInstalledPluginParams = z.strictObject({
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key')
})

export const PluginSetEnabledParams = z.object({
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key'),
  enabled: z.boolean()
})

export const PluginReadPanelEntryParams = z.object({
  pluginKey: z.string().min(1),
  panelId: z.string().min(1)
})

export const PluginInvokeCommandParams = z.object({
  pluginKey: z.string().min(1),
  commandId: z.string().min(1),
  args: z.unknown().optional()
})

export const PluginsPanelActionParams = z.unknown()
