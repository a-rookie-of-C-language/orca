import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'
import type { MuseUsageStore } from '../muse-usage/store'
import type { OpenCodeUsageStore } from '../opencode-usage/store'

export type RuntimeUsageProvider = 'claude' | 'codex' | 'opencode' | 'muse'
export type RuntimeUsageScope = 'orca' | 'all'
export type RuntimeUsageRange = '7d' | '30d' | '90d' | 'all'
export type RuntimeUsageBreakdownKind = 'model' | 'project'

export type RuntimeUsageStores = {
  claude: ClaudeUsageStore
  codex: CodexUsageStore
  opencode: OpenCodeUsageStore
  muse: MuseUsageStore
}

type RuntimeUsageStore = RuntimeUsageStores[RuntimeUsageProvider]

/** Runtime-owned usage access for Tauri and paired clients. */
export class RuntimeUsageController {
  constructor(private readonly stores: Partial<RuntimeUsageStores> = {}) {}

  async getScanState(provider: RuntimeUsageProvider): Promise<unknown> {
    const store = this.requireStore(provider)
    await store.whenLoaded()
    return store.getScanState()
  }

  setEnabled(provider: RuntimeUsageProvider, enabled: boolean): Promise<unknown> {
    return this.requireStore(provider).setEnabled(enabled)
  }

  refresh(provider: RuntimeUsageProvider, force = false): Promise<unknown> {
    return this.requireStore(provider).refresh(force)
  }

  async getSnapshot(
    provider: RuntimeUsageProvider,
    scope: RuntimeUsageScope,
    range: RuntimeUsageRange,
    limit?: number
  ): Promise<unknown> {
    const store = this.requireStore(provider)
    await store.whenLoaded()
    return store.getSnapshot(scope, range, limit)
  }

  getSummary(
    provider: RuntimeUsageProvider,
    scope: RuntimeUsageScope,
    range: RuntimeUsageRange
  ): Promise<unknown> {
    return this.requireStore(provider).getSummary(scope, range)
  }

  getDaily(
    provider: RuntimeUsageProvider,
    scope: RuntimeUsageScope,
    range: RuntimeUsageRange
  ): Promise<unknown> {
    return this.requireStore(provider).getDaily(scope, range)
  }

  getBreakdown(
    provider: RuntimeUsageProvider,
    scope: RuntimeUsageScope,
    range: RuntimeUsageRange,
    kind: RuntimeUsageBreakdownKind
  ): Promise<unknown> {
    return this.requireStore(provider).getBreakdown(scope, range, kind)
  }

  getRecentSessions(
    provider: RuntimeUsageProvider,
    scope: RuntimeUsageScope,
    range: RuntimeUsageRange,
    limit?: number
  ): Promise<unknown> {
    return this.requireStore(provider).getRecentSessions(scope, range, limit)
  }

  private requireStore(provider: RuntimeUsageProvider): RuntimeUsageStore {
    const store = this.stores[provider]
    if (!store) {
      throw new Error(`usage_unavailable:${provider}`)
    }
    return store
  }
}
