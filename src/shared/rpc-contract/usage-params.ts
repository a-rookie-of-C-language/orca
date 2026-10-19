import { z } from 'zod'
import { OptionalFiniteNumber } from './rpc-param-primitives'

export const UsageProvider = z.enum(['claude', 'codex', 'opencode', 'muse'])
export const UsageScope = z.enum(['orca', 'all'])
export const UsageRange = z.enum(['7d', '30d', '90d', 'all'])
export const UsageBreakdownKind = z.enum(['model', 'project'])

export const UsageProviderParams = z.object({ provider: UsageProvider }).strict()

export const UsageSetEnabledParams = UsageProviderParams.extend({
  enabled: z.boolean()
}).strict()

export const UsageRefreshParams = UsageProviderParams.extend({
  force: z.boolean().optional()
}).strict()

export const UsageQueryParams = UsageProviderParams.extend({
  scope: UsageScope,
  range: UsageRange
}).strict()

export const UsageSnapshotParams = UsageQueryParams.extend({
  limit: OptionalFiniteNumber
}).strict()

export const UsageBreakdownParams = UsageQueryParams.extend({
  kind: UsageBreakdownKind
}).strict()

export const UsageRecentSessionsParams = UsageQueryParams.extend({
  limit: OptionalFiniteNumber
}).strict()
