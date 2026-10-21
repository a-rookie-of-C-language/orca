type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- SAFETY: Window augmentation is required to type Tauri's injected runtime handle.
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke: TauriInvoke
    }
    __TAURI__?: {
      core?: {
        addPluginListener: <T>(
          plugin: string,
          event: string,
          handler: (payload: T) => void
        ) => Promise<{ unregister: () => Promise<void> }>
      }
      event?: TauriEventApi
      notification?: {
        onAction: <T>(handler: (payload: T) => void) => Promise<{ unregister: () => Promise<void> }>
      }
    }
  }
}

const TAURI_UNAVAILABLE_ERROR = 'Tauri native bridge is unavailable.'

function getInvoke(): TauriInvoke | null {
  return typeof window === 'undefined' ? null : (window.__TAURI_INTERNALS__?.invoke ?? null)
}

export function isTauriNativeHost(): boolean {
  return getInvoke() !== null
}

export function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = getInvoke()
  if (!invoke) {
    return Promise.reject(new Error(TAURI_UNAVAILABLE_ERROR))
  }
  return invoke<T>(command, args)
}

export function invokePlugin<T>(
  plugin: string,
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  return invokeNative<T>(`plugin:${plugin}|${command}`, args)
}

type TauriUnlisten = () => void

type TauriEventApi = {
  listen: <T>(event: string, handler: (event: { payload: T }) => void) => Promise<TauriUnlisten>
  emit?: <T>(event: string, payload?: T) => Promise<void>
}

function getTauriEventApi(): TauriEventApi | null {
  if (typeof window === 'undefined') {
    return null
  }
  const tauri = window.__TAURI__
  return tauri?.event?.listen ? tauri.event : null
}

export function listenNative<T>(event: string, callback: (payload: T) => void): () => void {
  const eventApi = getTauriEventApi()
  if (!eventApi) {
    return () => {}
  }
  let disposed = false
  let unlisten: TauriUnlisten | null = null
  void eventApi
    .listen<T>(event, (message) => callback(message.payload))
    .then((dispose) => {
      if (disposed) {
        dispose()
      } else {
        unlisten = dispose
      }
    })
    .catch(() => {})
  return () => {
    disposed = true
    unlisten?.()
    unlisten = null
  }
}

// Why: guest WebViews pull the handled-shortcut set on init but also need
// live updates; emitting a Tauri event reaches every WebView without a
// per-guest invoke round-trip.
export function emitNative<T>(event: string, payload?: T): Promise<void> {
  if (!isTauriNativeHost()) {
    return Promise.resolve()
  }
  const eventApi = getTauriEventApi()
  if (!eventApi || typeof eventApi.emit !== 'function') {
    return Promise.resolve()
  }
  return eventApi.emit<T>(event, payload).catch(() => {})
}
