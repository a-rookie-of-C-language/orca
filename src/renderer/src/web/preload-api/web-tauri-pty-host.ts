import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { unwrapRuntimeRpcResult } from '../../runtime/runtime-rpc-result'
import { callEnvironmentEnvelope } from './web-runtime-calls'

export async function callTauriPtyHost<TResult>(
  id: string,
  method: string,
  params: unknown
): Promise<TResult> {
  const environmentId = parseRemoteRuntimePtyId(id)?.environmentId
  if (!environmentId) {
    throw new Error('terminal_owner_unavailable')
  }
  return unwrapRuntimeRpcResult(
    await callEnvironmentEnvelope<TResult>(environmentId, method, params)
  )
}
