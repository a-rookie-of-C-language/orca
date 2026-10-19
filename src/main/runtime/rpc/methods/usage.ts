import { defineMethod } from '../core'
import {
  UsageBreakdownParams,
  UsageProviderParams,
  UsageQueryParams,
  UsageRecentSessionsParams,
  UsageRefreshParams,
  UsageSetEnabledParams,
  UsageSnapshotParams
} from '../../../../shared/rpc-contract/usage-params'

export const USAGE_METHODS = [
  defineMethod({
    name: 'usage.getScanState',
    permission: 'workspace',
    params: UsageProviderParams,
    handler: (params, { runtime }) => runtime.getUsageScanState(params.provider)
  }),
  defineMethod({
    name: 'usage.setEnabled',
    permission: 'workspace',
    params: UsageSetEnabledParams,
    handler: (params, { runtime }) => runtime.setUsageEnabled(params.provider, params.enabled)
  }),
  defineMethod({
    name: 'usage.refresh',
    permission: 'workspace',
    params: UsageRefreshParams,
    handler: (params, { runtime }) => runtime.refreshUsage(params.provider, params.force)
  }),
  defineMethod({
    name: 'usage.getSnapshot',
    permission: 'workspace',
    params: UsageSnapshotParams,
    handler: (params, { runtime }) =>
      runtime.getUsageSnapshot(params.provider, params.scope, params.range, params.limit)
  }),
  defineMethod({
    name: 'usage.getSummary',
    permission: 'workspace',
    params: UsageQueryParams,
    handler: (params, { runtime }) =>
      runtime.getUsageSummary(params.provider, params.scope, params.range)
  }),
  defineMethod({
    name: 'usage.getDaily',
    permission: 'workspace',
    params: UsageQueryParams,
    handler: (params, { runtime }) =>
      runtime.getUsageDaily(params.provider, params.scope, params.range)
  }),
  defineMethod({
    name: 'usage.getBreakdown',
    permission: 'workspace',
    params: UsageBreakdownParams,
    handler: (params, { runtime }) =>
      runtime.getUsageBreakdown(params.provider, params.scope, params.range, params.kind)
  }),
  defineMethod({
    name: 'usage.getRecentSessions',
    permission: 'workspace',
    params: UsageRecentSessionsParams,
    handler: (params, { runtime }) =>
      runtime.getUsageRecentSessions(params.provider, params.scope, params.range, params.limit)
  })
]
