import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { startOrcadSsh } from './orcad-ssh'
import { startOrcadWslHosts } from './orcad-wsl-hosts'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'

export function startOrcadSshAndWslHosts(input: {
  runtime: OrcaRuntimeService
  store: Store
  userDataPath: string
  registerCleanup: (cleanup: OrcadRuntimeCleanup) => void
}): void {
  startOrcadSsh(input)
  startOrcadWslHosts(input)
}
