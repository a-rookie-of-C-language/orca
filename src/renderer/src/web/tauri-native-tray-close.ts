import { invokeNative, isTauriNativeHost } from './tauri-native-host'

// Why: the native close handler cannot read the renderer's settings store on
// Alt+F4 / the OS X button, so the renderer pushes `minimizeToTrayOnClose`
// into Rust state on startup and on every change. Mirrors Electron's
// `hideToTrayIfEnabled` which reads the setting synchronously in main.
export async function syncTauriMinimizeToTray(enabled: boolean): Promise<void> {
  if (!isTauriNativeHost()) {
    return
  }
  await invokeNative('poc_set_minimize_to_tray', { enabled }).catch(() => {})
}
