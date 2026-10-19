import { invokeNative, isTauriNativeHost } from './tauri-native-host'

// Why: agent-driven guest keys must not run Orca shortcuts or grab actions
// (Electron withAgentInputInjection parity). Rust drops bridged keys while
// the page is marked; the page itself still receives them.
export async function withTauriAgentBrowserInput<T>(
  browserPageId: string,
  run: () => Promise<T>
): Promise<T> {
  let marked = false
  if (isTauriNativeHost()) {
    try {
      await invokeNative('poc_browser_agent_input_begin', { args: { browserPageId } })
      marked = true
    } catch {
      // Best effort: marking is parity hardening; delivering the input is the contract.
    }
  }
  try {
    return await run()
  } finally {
    if (marked) {
      await invokeNative('poc_browser_agent_input_end', { args: { browserPageId } }).catch(() => {})
    }
  }
}
