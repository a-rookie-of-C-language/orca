import type { PreloadApi } from '../../../preload/api-types'
import type { AppApi, PlatformApi } from '../../../preload/api/app-api'
import type {
  RuntimeMobileSessionAgentTab,
  RuntimeMobileSessionTabsResult
} from '../../../shared/runtime-types'
import { createWebAppApi } from './preload-api/web-app-api'
import { createWebRuntimeApi } from './preload-api/web-runtime-api'
import { callRuntimeResult } from './preload-api/web-runtime-calls'
import { getBrowserPlatform } from './preload-api/web-storage'
import { invokeNative, isTauriNativeHost } from './tauri-native-host'
import { prepareAndInvokeAppRestart } from '../../../preload/renderer-restart-wiring'

type TauriNativePlatformInfo = Awaited<ReturnType<PlatformApi['get']>>
type TauriNativeAppIdentity = Awaited<ReturnType<AppApi['getIdentity']>>

async function readNativePlatformInfo(): Promise<TauriNativePlatformInfo> {
  return invokeNative<TauriNativePlatformInfo>('poc_platform_info')
}

function fallbackPlatformInfo(): TauriNativePlatformInfo {
  return {
    platform: getBrowserPlatform(),
    osRelease: '',
    arch: '',
    shell: '',
    displayServer: null
  }
}

let cachedNativePlatformInfo: TauriNativePlatformInfo | undefined
let structuredSessionHeld: boolean | undefined
let structuredSessionSubscription: { unsubscribe: () => void } | null = null
let structuredSessionSubscriptionStart: Promise<void> | null = null
let structuredSessionRetryTimer: ReturnType<typeof setTimeout> | null = null
const structuredSessionHeldListeners = new Set<(held: boolean) => void>()

function isSessionTabsResult(
  value: unknown
): value is { snapshots?: RuntimeMobileSessionTabsResult[] } {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  if (!('snapshots' in value)) {
    return true
  }
  const snapshots = value.snapshots
  return (
    snapshots === undefined ||
    (Array.isArray(snapshots) &&
      snapshots.every(
        (snapshot) =>
          typeof snapshot === 'object' &&
          snapshot !== null &&
          'tabs' in snapshot &&
          Array.isArray(snapshot.tabs)
      ))
  )
}

function isAgentSessionTab(tab: unknown): tab is RuntimeMobileSessionAgentTab {
  return typeof tab === 'object' && tab !== null && 'type' in tab && tab.type === 'agent-session'
}

async function holdsTauriStructuredAgentSessions(): Promise<boolean> {
  try {
    const result = await callRuntimeResult<unknown>('session.tabs.listAll')
    if (!isSessionTabsResult(result)) {
      return false
    }
    return (result.snapshots ?? []).some((snapshot) => snapshot.tabs.some(isAgentSessionTab))
  } catch {
    // Runtime startup and first pairing happen before the renderer is mounted;
    // an unavailable inventory is not evidence that the sessions were deleted.
    return false
  }
}

async function refreshTauriStructuredAgentSessionSignal(): Promise<void> {
  const next = await holdsTauriStructuredAgentSessions()
  const changed = structuredSessionHeld !== undefined && structuredSessionHeld !== next
  structuredSessionHeld = next
  if (changed) {
    for (const listener of structuredSessionHeldListeners) {
      listener(next)
    }
  }
}

function stopTauriStructuredAgentSessionSubscription(): void {
  if (structuredSessionRetryTimer !== null) {
    clearTimeout(structuredSessionRetryTimer)
    structuredSessionRetryTimer = null
  }
  structuredSessionSubscription?.unsubscribe()
  structuredSessionSubscription = null
  structuredSessionSubscriptionStart = null
}

function scheduleTauriStructuredAgentSessionSubscription(): void {
  if (structuredSessionHeldListeners.size === 0 || structuredSessionRetryTimer !== null) {
    return
  }
  structuredSessionRetryTimer = setTimeout(() => {
    structuredSessionRetryTimer = null
    void startTauriStructuredAgentSessionSubscription()
  }, 500)
}

async function startTauriStructuredAgentSessionSubscription(): Promise<void> {
  if (
    structuredSessionHeldListeners.size === 0 ||
    structuredSessionSubscription ||
    structuredSessionSubscriptionStart
  ) {
    return structuredSessionSubscriptionStart ?? Promise.resolve()
  }
  const start = (async () => {
    try {
      const subscription = await createWebRuntimeApi().subscribe(
        { method: 'session.tabs.subscribeAll', params: {} },
        () => {
          void refreshTauriStructuredAgentSessionSignal().catch(() => {})
        }
      )
      if (structuredSessionHeldListeners.size === 0) {
        subscription.unsubscribe()
      } else {
        structuredSessionSubscription = subscription
      }
    } catch {
      scheduleTauriStructuredAgentSessionSubscription()
    }
  })()
  structuredSessionSubscriptionStart = start
  try {
    await start
  } finally {
    structuredSessionSubscriptionStart = null
  }
}

function onTauriStructuredAgentSessionsHeldChanged(callback: (held: boolean) => void): () => void {
  structuredSessionHeldListeners.add(callback)
  void refreshTauriStructuredAgentSessionSignal().catch(() => {})
  void startTauriStructuredAgentSessionSubscription()
  return () => {
    structuredSessionHeldListeners.delete(callback)
    if (structuredSessionHeldListeners.size === 0) {
      stopTauriStructuredAgentSessionSubscription()
    }
  }
}

export function createTauriNativePlatformApi(): Partial<PlatformApi> {
  if (!isTauriNativeHost()) {
    return {}
  }
  void readNativePlatformInfo().then((info) => {
    cachedNativePlatformInfo = info
  })
  return {
    get: () => {
      cachedNativePlatformInfo ??= fallbackPlatformInfo()
      void readNativePlatformInfo().then((info) => {
        cachedNativePlatformInfo = info
      })
      return cachedNativePlatformInfo
    }
  }
}

export function createTauriNativePlatformNamespaceApi(): Pick<PreloadApi, 'platform'> {
  const api = createTauriNativePlatformApi()
  return {
    platform: {
      get: () => api.get?.() ?? fallbackPlatformInfo()
    }
  }
}

export function createTauriNativeAppApi(): Partial<AppApi> {
  if (!isTauriNativeHost()) {
    return {}
  }
  // Resolve the installed checkpoint lazily to preserve state before replacing the native owner.
  const awaitBeforeUnloadCheckpoint = (): Promise<void> =>
    window.api?.app?.awaitBeforeUnloadCheckpoint?.() ?? Promise.resolve()
  const invokeRestart = (): Promise<void> =>
    prepareAndInvokeAppRestart(
      window,
      () => invokeNative('poc_relaunch'),
      awaitBeforeUnloadCheckpoint
    )
  return {
    ...createWebAppApi().app,
    getIdentity: () => invokeNative<TauriNativeAppIdentity>('poc_app_identity'),
    // Why native: Settings shows the same elevation row as Electron. The
    // Rust command runs the same bundled launcher probe, so the web null
    // fallback only applies off the Tauri host.
    getWindowsAdministratorStatus: () =>
      invokeNative<boolean | null>('poc_get_windows_administrator_status'),
    // Tauri owns a local orcad runtime through the same RPC boundary as a
    // paired desktop. Query its durable inventory so existing Codex/Claude
    // chats are restored even when the new-chat preference is disabled.
    holdsStructuredAgentSessions: holdsTauriStructuredAgentSessions,
    onStructuredAgentSessionsHeldChanged: onTauriStructuredAgentSessionsHeldChanged,
    // `reload` intentionally keeps the Rust process and sidecar alive. The
    // other two operations must replace the native owner, like Electron's
    // app.relaunch()/restart() do.
    reload: () =>
      prepareAndInvokeAppRestart(
        window,
        async () => window.location.reload(),
        awaitBeforeUnloadCheckpoint
      ),
    relaunch: invokeRestart,
    restart: invokeRestart
  }
}

export function createTauriNativeAppNamespaceApi(): Pick<PreloadApi, 'app'> {
  const api = createTauriNativeAppApi()
  const fallback = createWebAppApi().app
  if (!fallback) {
    throw new Error('The web app API fallback is unavailable.')
  }
  return {
    app: {
      ...fallback,
      getIdentity: api.getIdentity ?? fallback.getIdentity,
      getWindowsAdministratorStatus:
        api.getWindowsAdministratorStatus ?? fallback.getWindowsAdministratorStatus,
      holdsStructuredAgentSessions:
        api.holdsStructuredAgentSessions ?? fallback.holdsStructuredAgentSessions,
      onStructuredAgentSessionsHeldChanged:
        api.onStructuredAgentSessionsHeldChanged ?? fallback.onStructuredAgentSessionsHeldChanged,
      reload: api.reload ?? fallback.reload,
      relaunch: api.relaunch ?? fallback.relaunch,
      restart: api.restart ?? fallback.restart
    }
  }
}
