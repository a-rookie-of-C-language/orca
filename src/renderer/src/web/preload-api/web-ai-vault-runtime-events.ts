import type { AiVaultScanProgressUpdate } from '../../../../shared/ai-vault-scan-progress'
import { subscribeRuntimeClientEvents } from '../../runtime/runtime-client-events'
import { requireActiveEnvironmentOrNull } from './web-runtime-session'

const listeners = new Set<(update: AiVaultScanProgressUpdate) => void>()
let subscription: { unsubscribe: () => void } | null = null
let subscriptionPromise: Promise<void> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null

function scheduleRetry(): void {
  if (retryTimer || listeners.size === 0) {
    return
  }
  retryTimer = setTimeout(() => {
    retryTimer = null
    ensureSubscription()
  }, 500)
}

function ensureSubscription(): void {
  if (subscription || subscriptionPromise || listeners.size === 0) {
    return
  }
  const environment = requireActiveEnvironmentOrNull()
  if (!environment) {
    return
  }
  subscriptionPromise = subscribeRuntimeClientEvents(
    environment.id,
    (event) => {
      if (event.type !== 'aiVaultScanProgress') {
        return
      }
      for (const listener of listeners) {
        listener({ scanKey: event.scanKey, progress: event.progress })
      }
    },
    () => scheduleRetry()
  )
    .then((next) => {
      subscriptionPromise = null
      if (listeners.size === 0) {
        next.unsubscribe()
        return
      }
      subscription = next
    })
    .catch(() => {
      subscriptionPromise = null
      scheduleRetry()
    })
}

function releaseIfUnused(): void {
  if (listeners.size > 0) {
    return
  }
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  subscription?.unsubscribe()
  subscription = null
}

export function onAiVaultScanProgress(
  listener: (update: AiVaultScanProgressUpdate) => void
): () => void {
  listeners.add(listener)
  ensureSubscription()
  return () => {
    listeners.delete(listener)
    releaseIfUnused()
  }
}
