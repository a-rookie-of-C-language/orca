import { isTauriNativeHost, listenNative } from './tauri-native-host'

export type TauriBrowserGuestShortcutPayload = {
  browserPageId: string
  eventType: 'keydown' | 'keyup'
  key: string
  code: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  repeat: boolean
}

const EVENT_BROWSER_GUEST_SHORTCUT = 'browser:guest-shortcut'
const EVENT_BROWSER_GUEST_CTRL_TAB_COMMIT = 'browser:guest-ctrl-tab-commit'

// Why: a focused browser guest is its own document whose key events never
// reach the main window; re-dispatch shortcut-grade chords here so the shared
// global keybindings handle them exactly like local keypresses.
let guestShortcutForwardingInstalled = false

// Why: the guest bridge can redeliver one physical press more than once.
// A held physical key cannot re-press without release, so non-repeat
// keydowns for held codes and keyups for unheld codes are duplicates.
const heldGuestCodes = new Set<string>()

function isDuplicateGuestChord(payload: TauriBrowserGuestShortcutPayload): boolean {
  if (payload.eventType === 'keydown') {
    if (payload.repeat === true) {
      return false
    }
    if (heldGuestCodes.has(payload.code)) {
      return true
    }
    heldGuestCodes.add(payload.code)
    return false
  }
  if (!heldGuestCodes.has(payload.code)) {
    return true
  }
  heldGuestCodes.delete(payload.code)
  return false
}

export function installTauriBrowserGuestShortcutForwarding(): () => void {
  if (!isTauriNativeHost() || guestShortcutForwardingInstalled) {
    return () => {}
  }
  guestShortcutForwardingInstalled = true
  window.addEventListener('blur', () => heldGuestCodes.clear())
  return listenNative<TauriBrowserGuestShortcutPayload>(EVENT_BROWSER_GUEST_SHORTCUT, (payload) => {
    if (
      !payload ||
      (payload.eventType !== 'keydown' && payload.eventType !== 'keyup') ||
      (typeof payload.code === 'string' &&
        payload.code.length > 0 &&
        isDuplicateGuestChord(payload))
    ) {
      return
    }
    window.dispatchEvent(
      new KeyboardEvent(payload.eventType, {
        key: payload.key,
        code: payload.code,
        ctrlKey: payload.ctrlKey === true,
        shiftKey: payload.shiftKey === true,
        altKey: payload.altKey === true,
        metaKey: payload.metaKey === true,
        repeat: payload.repeat === true,
        bubbles: true,
        cancelable: true,
        composed: true
      })
    )
  })
}

let guestCtrlTabCommitInstalled = false

// Why: a guest-held Ctrl+Tab switcher commits on Control release, but bare
// Control keyup never crosses the bridge; synthesize it so the shared overlay
// commits exactly like a local press (harmless when no switcher is open).
export function installTauriBrowserGuestCtrlTabCommit(): () => void {
  if (!isTauriNativeHost() || guestCtrlTabCommitInstalled) {
    return () => {}
  }
  guestCtrlTabCommitInstalled = true
  return listenNative<{ browserPageId: string }>(EVENT_BROWSER_GUEST_CTRL_TAB_COMMIT, () => {
    window.dispatchEvent(
      new KeyboardEvent('keyup', {
        key: 'Control',
        code: 'ControlLeft',
        bubbles: true,
        cancelable: true,
        composed: true
      })
    )
  })
}
