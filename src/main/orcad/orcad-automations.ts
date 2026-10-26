import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'
import { createRuntimeAutomationService } from '../automations/runtime-automation-service'
import { isFinalAutomationRunStatus } from '../../shared/automations-types'

type AutomationStore = Pick<Store, 'listAutomations' | 'listAutomationRuns'>

let stopScheduler: (() => void) | null = null

export function startOrcadAutomations(
  runtime: OrcaRuntimeService,
  store: Store,
  registerCleanup: (cleanup: () => void | Promise<void>) => void,
  usage?: { claudeUsage: ClaudeUsageStore; codexUsage: CodexUsageStore }
): void {
  const service = createRuntimeAutomationService({
    store,
    runtime,
    headless: true,
    ...usage
  })
  stopScheduler = () => service.stop()
  // Stop before final profile flush so runs cannot persist afterward.
  registerCleanup(() => service.stop())
  service.start()
}

export function stopOrcadAutomationScheduler(): void {
  stopScheduler?.()
}

/** Pending schedules/runs must keep the host alive. */
export function orcadAutomationsKeepHostBusy(store: AutomationStore): boolean {
  return (
    store.listAutomations().some((automation) => automation.enabled) ||
    store.listAutomationRuns().some((run) => !isFinalAutomationRunStatus(run.status))
  )
}
