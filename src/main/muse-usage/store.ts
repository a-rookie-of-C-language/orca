import { createRequire } from 'node:module'
import { join } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import type {
  MuseUsageBreakdownKind,
  MuseUsageBreakdownRow,
  MuseUsageDailyPoint,
  MuseUsageRange,
  MuseUsageScope,
  MuseUsageSessionRow,
  MuseUsageSnapshot,
  MuseUsageSummary
} from '../../shared/muse-usage-types'
import type { Store } from '../persistence'
import { UsageProviderStoreLifecycle } from '../usage/usage-provider-store-lifecycle'
import { splitUsageCacheFileViaWorker } from '../usage/usage-scan-worker-spawn'
import { filterUsageDaily, filterUsageSessions } from '../usage/usage-scope-filters'
import { museUsageProvider } from './muse-usage-provider'
import { getDefaultMuseUsageState, normalizeMuseUsageState } from './persisted-state-normalization'
import {
  buildMuseUsageBreakdownRows,
  buildMuseUsageDailyPoints,
  buildMuseUsageRecentSessions,
  buildMuseUsageSummary
} from './snapshot-rollups'
import type { MuseUsageDailyAggregate, MuseUsagePersistedState, MuseUsageSession } from './types'

let museUsageFile: string | null = null

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

export function initMuseUsagePath(userDataPath?: string): void {
  museUsageFile = join(userDataPath ?? defaultUserDataPath(), 'orca-muse-usage.json')
}

function getMuseUsageFile(): string {
  museUsageFile ??= join(defaultUserDataPath(), 'orca-muse-usage.json')
  return museUsageFile
}

export class MuseUsageStore extends UsageProviderStoreLifecycle<
  'processedFiles',
  MuseUsagePersistedState,
  'hasAnyMuseData'
> {
  constructor(store: Pick<Store, 'getRepos' | 'getAllWorktreeMeta'>, userDataPath?: string) {
    const cacheFile = userDataPath ? join(userDataPath, 'orca-muse-usage.json') : getMuseUsageFile()
    super(store, {
      logTag: '[muse-usage]',
      resolveCacheFile: () => cacheFile,
      createDefaultState: getDefaultMuseUsageState,
      normalizeState: normalizeMuseUsageState,
      sourceKey: 'processedFiles',
      dataPresenceKey: 'hasAnyMuseData',
      scan: museUsageProvider.scan,
      splitCacheFile: splitUsageCacheFileViaWorker
    })
  }

  getSnapshot(
    scope: MuseUsageScope,
    range: MuseUsageRange,
    recentSessionLimit = 10
  ): MuseUsageSnapshot {
    const daily = this.getFilteredDaily(scope, range)
    const sessions = this.getFilteredSessions(scope, range)
    return {
      scanState: this.getScanState(),
      summary: buildMuseUsageSummary(scope, range, daily, sessions),
      daily: buildMuseUsageDailyPoints(daily),
      modelBreakdown: buildMuseUsageBreakdownRows('model', scope, daily, sessions),
      projectBreakdown: buildMuseUsageBreakdownRows('project', scope, daily, sessions),
      recentSessions: buildMuseUsageRecentSessions(sessions, recentSessionLimit)
    }
  }

  async getSummary(scope: MuseUsageScope, range: MuseUsageRange): Promise<MuseUsageSummary> {
    await this.refresh(false)
    return this.buildSummary(scope, range)
  }

  async getDaily(scope: MuseUsageScope, range: MuseUsageRange): Promise<MuseUsageDailyPoint[]> {
    await this.refresh(false)
    return buildMuseUsageDailyPoints(this.getFilteredDaily(scope, range))
  }

  async getBreakdown(
    scope: MuseUsageScope,
    range: MuseUsageRange,
    kind: MuseUsageBreakdownKind
  ): Promise<MuseUsageBreakdownRow[]> {
    await this.refresh(false)
    return this.buildBreakdown(scope, range, kind)
  }

  async getRecentSessions(
    scope: MuseUsageScope,
    range: MuseUsageRange,
    limit = 10
  ): Promise<MuseUsageSessionRow[]> {
    await this.refresh(false)
    return buildMuseUsageRecentSessions(this.getFilteredSessions(scope, range), limit)
  }

  private buildSummary(scope: MuseUsageScope, range: MuseUsageRange): MuseUsageSummary {
    return buildMuseUsageSummary(
      scope,
      range,
      this.getFilteredDaily(scope, range),
      this.getFilteredSessions(scope, range)
    )
  }

  private buildBreakdown(
    scope: MuseUsageScope,
    range: MuseUsageRange,
    kind: MuseUsageBreakdownKind
  ): MuseUsageBreakdownRow[] {
    return buildMuseUsageBreakdownRows(
      kind,
      scope,
      this.getFilteredDaily(scope, range),
      this.getFilteredSessions(scope, range)
    )
  }

  private getFilteredDaily(
    scope: MuseUsageScope,
    range: MuseUsageRange
  ): MuseUsageDailyAggregate[] {
    return filterUsageDaily(this.state.dailyAggregates, scope, range)
  }

  private getFilteredSessions(scope: MuseUsageScope, range: MuseUsageRange): MuseUsageSession[] {
    return filterUsageSessions(this.state.sessions, scope, range)
  }
}
