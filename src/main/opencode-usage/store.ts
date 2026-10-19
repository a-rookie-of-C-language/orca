import { codexOpenCodeTokenSessions } from '../usage/agent-token-usage'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import type {
  OpenCodeUsageBreakdownKind,
  OpenCodeUsageBreakdownRow,
  OpenCodeUsageDailyPoint,
  OpenCodeUsageRange,
  OpenCodeUsageScope,
  OpenCodeUsageSessionRow,
  OpenCodeUsageSnapshot,
  OpenCodeUsageSummary
} from '../../shared/opencode-usage-types'
import type { Store } from '../persistence'
import type {
  OpenCodeUsageDailyAggregate,
  OpenCodeUsagePersistedState,
  OpenCodeUsageSession
} from './types'
import { openCodeUsageProvider } from './opencode-usage-provider'
import { getDefaultState, normalizePersistedState } from './persisted-state-normalization'
import {
  filterDailyAggregatesByScopeAndRange,
  filterSessionsByScopeAndRange
} from './scope-range-filter'
import {
  buildOpenCodeUsageBreakdownRows,
  buildOpenCodeUsageDailyPoints,
  buildOpenCodeUsageRecentSessions,
  buildOpenCodeUsageSummary
} from './snapshot-rollups'
import { UsageProviderStoreLifecycle } from '../usage/usage-provider-store-lifecycle'
import { splitUsageCacheFileViaWorker } from '../usage/usage-scan-worker-spawn'

let _openCodeUsageFile: string | null = null

const require = createRequire(import.meta.url)

function defaultUserDataPath(): string {
  if (hasAppEnvironment()) {
    return getAppEnvironment().getPath('userData')
  }
  const electron: unknown = require('electron')
  if (
    typeof electron === 'object' &&
    electron !== null &&
    'app' in electron &&
    typeof electron.app === 'object' &&
    electron.app !== null &&
    'getPath' in electron.app &&
    typeof electron.app.getPath === 'function'
  ) {
    return electron.app.getPath('userData')
  }
  throw new Error('Electron app environment is unavailable')
}

export function initOpenCodeUsagePath(userDataPath?: string): void {
  _openCodeUsageFile = join(userDataPath ?? defaultUserDataPath(), 'orca-opencode-usage.json')
}

function getOpenCodeUsageFile(): string {
  const file = _openCodeUsageFile
  if (file) {
    return file
  }
  initOpenCodeUsagePath()
  if (!_openCodeUsageFile) {
    throw new Error('OpenCode usage path is unavailable')
  }
  return _openCodeUsageFile
}

export class OpenCodeUsageStore extends UsageProviderStoreLifecycle<
  'processedDatabases',
  OpenCodeUsagePersistedState,
  'hasAnyOpenCodeData'
> {
  constructor(store: Pick<Store, 'getRepos' | 'getAllWorktreeMeta'>, userDataPath?: string) {
    const cacheFile = userDataPath
      ? join(userDataPath, 'orca-opencode-usage.json')
      : getOpenCodeUsageFile()
    super(store, {
      tokenUsage: {
        provider: 'opencode',
        selectSessions: (state) => codexOpenCodeTokenSessions(state.sessions)
      },
      logTag: '[opencode-usage]',
      resolveCacheFile: () => cacheFile,
      createDefaultState: getDefaultState,
      normalizeState: normalizePersistedState,
      sourceKey: 'processedDatabases',
      dataPresenceKey: 'hasAnyOpenCodeData',
      scan: openCodeUsageProvider.scan,
      splitCacheFile: splitUsageCacheFileViaWorker
    })
  }

  getSnapshot(
    scope: OpenCodeUsageScope,
    range: OpenCodeUsageRange,
    recentSessionLimit = 10
  ): OpenCodeUsageSnapshot {
    return {
      scanState: this.getScanState(),
      summary: this.buildSummary(scope, range),
      daily: this.buildDaily(scope, range),
      modelBreakdown: this.buildBreakdown(scope, range, 'model'),
      projectBreakdown: this.buildBreakdown(scope, range, 'project'),
      recentSessions: this.buildRecentSessions(scope, range, recentSessionLimit)
    }
  }

  async getSummary(
    scope: OpenCodeUsageScope,
    range: OpenCodeUsageRange
  ): Promise<OpenCodeUsageSummary> {
    await this.refresh(false)
    return this.buildSummary(scope, range)
  }

  private buildSummary(scope: OpenCodeUsageScope, range: OpenCodeUsageRange): OpenCodeUsageSummary {
    return buildOpenCodeUsageSummary(
      scope,
      range,
      this.getFilteredDaily(scope, range),
      this.getFilteredSessions(scope, range)
    )
  }

  async getDaily(
    scope: OpenCodeUsageScope,
    range: OpenCodeUsageRange
  ): Promise<OpenCodeUsageDailyPoint[]> {
    await this.refresh(false)
    return this.buildDaily(scope, range)
  }

  private buildDaily(
    scope: OpenCodeUsageScope,
    range: OpenCodeUsageRange
  ): OpenCodeUsageDailyPoint[] {
    return buildOpenCodeUsageDailyPoints(this.getFilteredDaily(scope, range))
  }

  async getBreakdown(
    scope: OpenCodeUsageScope,
    range: OpenCodeUsageRange,
    kind: OpenCodeUsageBreakdownKind
  ): Promise<OpenCodeUsageBreakdownRow[]> {
    await this.refresh(false)
    return this.buildBreakdown(scope, range, kind)
  }

  private buildBreakdown(
    scope: OpenCodeUsageScope,
    range: OpenCodeUsageRange,
    kind: OpenCodeUsageBreakdownKind
  ): OpenCodeUsageBreakdownRow[] {
    return buildOpenCodeUsageBreakdownRows(
      kind,
      this.getFilteredDaily(scope, range),
      this.getFilteredSessions(scope, range)
    )
  }

  async getRecentSessions(
    scope: OpenCodeUsageScope,
    range: OpenCodeUsageRange,
    limit = 10
  ): Promise<OpenCodeUsageSessionRow[]> {
    await this.refresh(false)
    return this.buildRecentSessions(scope, range, limit)
  }

  private buildRecentSessions(
    scope: OpenCodeUsageScope,
    range: OpenCodeUsageRange,
    limit = 10
  ): OpenCodeUsageSessionRow[] {
    return buildOpenCodeUsageRecentSessions(this.getFilteredSessions(scope, range), limit)
  }

  private getFilteredDaily(
    scope: OpenCodeUsageScope,
    range: OpenCodeUsageRange
  ): OpenCodeUsageDailyAggregate[] {
    return filterDailyAggregatesByScopeAndRange(this.state.dailyAggregates, scope, range)
  }

  private getFilteredSessions(
    scope: OpenCodeUsageScope,
    range: OpenCodeUsageRange
  ): OpenCodeUsageSession[] {
    return filterSessionsByScopeAndRange(this.state.sessions, scope, range)
  }
}
