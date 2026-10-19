// orcad keep-awake wiring: the verdict needs the hook server's status store
// and the host's settings, both of which live here. The Tauri shell consumes
// this over RPC and applies the OS blocker in its own process.

import { OrcadAgentAwakeService } from './orcad-agent-awake'
import { setAgentAwakeServiceForRpc } from '../runtime/rpc/methods/agent-awake'
import type { AgentHookServer } from '../agent-hooks/server'
import type { ProfilePreferences } from '../persistence/loading-store/profile-preferences'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'

export function startOrcadAgentAwakeService(
  store: Pick<ProfilePreferences, 'getSettings' | 'onSettingsChanged'>,
  hookServer: AgentHookServer,
  registerCleanup: (cleanup: OrcadRuntimeCleanup) => void
): OrcadAgentAwakeService {
  const service = new OrcadAgentAwakeService(store, hookServer)
  service.start()
  setAgentAwakeServiceForRpc(service)
  registerCleanup(() => {
    setAgentAwakeServiceForRpc(null)
    service.dispose()
  })
  return service
}
