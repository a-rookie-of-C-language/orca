import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { startWslHostRuntime, stopWslHostRuntime } from '../wsl/wsl-host-runtime'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'

/** Starts WSL-as-host support inside the Node-owned runtime used by Tauri. */
export function startOrcadWslHosts(input: {
  runtime: OrcaRuntimeService
  store: Store
  userDataPath: string
  registerCleanup: (cleanup: OrcadRuntimeCleanup) => void
}): void {
  const service = startWslHostRuntime({
    store: input.store,
    getUserDataPath: () => input.userDataPath,
    // The Tauri renderer owns the active WebRuntimeClient. A WSL reconnect is
    // reported through the runtime event stream instead of Electron's IPC transport registry.
    invalidateTransport: async () => {},
    publish: (status) => input.runtime.notifyWslHostStatusChanged(status)
  })
  if (!service) {
    return
  }
  input.registerCleanup(() => stopWslHostRuntime(service))
}
