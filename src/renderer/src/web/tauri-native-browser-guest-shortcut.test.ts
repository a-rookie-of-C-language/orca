// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

type GuestShortcutHandler = (payload: unknown) => void
const native = vi.hoisted(
  (): { handlers: GuestShortcutHandler[]; commitHandlers: GuestShortcutHandler[] } => ({
    handlers: [],
    commitHandlers: []
  })
)
vi.mock('./tauri-native-host', () => ({
  isTauriNativeHost: () => true,
  listenNative: (channel: string, handler: (payload: unknown) => void) => {
    if (channel === 'browser:guest-shortcut') {
      native.handlers.push(handler)
    }
    if (channel === 'browser:guest-ctrl-tab-commit') {
      native.commitHandlers.push(handler)
    }
    return () => {}
  }
}))

function emitShortcut(payload: Record<string, unknown>) {
  expect(native.handlers.length).toBeGreaterThan(0)
  for (const handler of native.handlers) {
    handler(payload)
  }
}

describe('Tauri browser guest shortcut forwarding', () => {
  beforeEach(() => {
    vi.resetModules()
    native.handlers.length = 0
    native.commitHandlers.length = 0
  })

  it('re-dispatches guest chords as window keyboard events', async () => {
    const { installTauriBrowserGuestShortcutForwarding } =
      await import('./tauri-native-browser-guest-shortcut')
    installTauriBrowserGuestShortcutForwarding()
    const seen: KeyboardEvent[] = []
    window.addEventListener('keydown', (event) => seen.push(event), { capture: true })
    window.addEventListener('keyup', (event) => seen.push(event), { capture: true })
    emitShortcut({
      browserPageId: 'page-1',
      eventType: 'keydown',
      key: 'b',
      code: 'KeyB',
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      repeat: false
    })
    emitShortcut({
      browserPageId: 'page-1',
      eventType: 'keyup',
      key: 'b',
      code: 'KeyB',
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      repeat: false
    })
    expect(seen.map((event) => event.type)).toEqual(['keydown', 'keyup'])
    expect(seen[0]?.key).toBe('b')
    expect(seen[0]?.code).toBe('KeyB')
    expect(seen[0]?.ctrlKey).toBe(true)
    expect(seen[1]?.key).toBe('b')
    expect(seen[1]?.code).toBe('KeyB')
    expect(seen[1]?.ctrlKey).toBe(false)
  })

  it('re-dispatches shift-held guest chords with the shift flag intact', async () => {
    const { installTauriBrowserGuestShortcutForwarding } =
      await import('./tauri-native-browser-guest-shortcut')
    installTauriBrowserGuestShortcutForwarding()
    const seen: KeyboardEvent[] = []
    window.addEventListener('keydown', (event) => seen.push(event), { capture: true })
    window.addEventListener('keyup', (event) => seen.push(event), { capture: true })
    emitShortcut({
      browserPageId: 'page-1',
      eventType: 'keydown',
      key: 'A',
      code: 'KeyA',
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      metaKey: false,
      repeat: false
    })
    emitShortcut({
      browserPageId: 'page-1',
      eventType: 'keyup',
      key: 'A',
      code: 'KeyA',
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      metaKey: false,
      repeat: false
    })
    expect(seen.map((event) => event.type)).toEqual(['keydown', 'keyup'])
    expect(seen[0]?.key).toBe('A')
    expect(seen[0]?.shiftKey).toBe(true)
    expect(seen[1]?.shiftKey).toBe(true)
  })

  it('installs only once across repeated calls', async () => {
    const { installTauriBrowserGuestShortcutForwarding } =
      await import('./tauri-native-browser-guest-shortcut')
    installTauriBrowserGuestShortcutForwarding()
    installTauriBrowserGuestShortcutForwarding()
    expect(native.handlers.length).toBe(1)
  })

  it('drops redelivered presses but keeps genuine repeats and re-presses', async () => {
    const { installTauriBrowserGuestShortcutForwarding } =
      await import('./tauri-native-browser-guest-shortcut')
    installTauriBrowserGuestShortcutForwarding()
    const seen: KeyboardEvent[] = []
    window.addEventListener('keydown', (event) => seen.push(event), { capture: true })
    window.addEventListener('keyup', (event) => seen.push(event), { capture: true })
    const chord = (eventType: string, repeat: boolean, code = 'KeyB') =>
      emitShortcut({
        browserPageId: 'page-1',
        eventType,
        key: 'b',
        code,
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        repeat
      })
    chord('keydown', false)
    chord('keydown', false)
    chord('keydown', true)
    chord('keyup', false)
    chord('keyup', false)
    chord('keydown', false)
    chord('keyup', false)
    expect(seen.map((event) => [event.type, event.repeat])).toEqual([
      ['keydown', false],
      ['keydown', true],
      ['keyup', false],
      ['keydown', false],
      ['keyup', false]
    ])
  })

  it('always dispatches chords without a physical code', async () => {
    const { installTauriBrowserGuestShortcutForwarding } =
      await import('./tauri-native-browser-guest-shortcut')
    installTauriBrowserGuestShortcutForwarding()
    const seen: KeyboardEvent[] = []
    window.addEventListener('keydown', (event) => seen.push(event), { capture: true })
    const chord = () =>
      emitShortcut({
        browserPageId: 'page-1',
        eventType: 'keydown',
        key: 'b',
        code: '',
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        repeat: false
      })
    chord()
    chord()
    expect(seen.length).toBe(2)
  })

  it('ignores malformed guest payloads', async () => {
    const { installTauriBrowserGuestShortcutForwarding } =
      await import('./tauri-native-browser-guest-shortcut')
    installTauriBrowserGuestShortcutForwarding()
    const seen: KeyboardEvent[] = []
    window.addEventListener('keydown', (event) => seen.push(event), { capture: true })
    emitShortcut({ browserPageId: 'page-1', eventType: 'keypress' })
    emitShortcut({})
    expect(seen).toEqual([])
  })
})

describe('Tauri browser guest Ctrl+Tab commit', () => {
  beforeEach(() => {
    vi.resetModules()
    native.handlers.length = 0
    native.commitHandlers.length = 0
  })

  it('synthesizes a Control keyup so the shared overlay commits', async () => {
    const { installTauriBrowserGuestCtrlTabCommit } =
      await import('./tauri-native-browser-guest-shortcut')
    installTauriBrowserGuestCtrlTabCommit()
    expect(native.commitHandlers.length).toBe(1)
    const seen: KeyboardEvent[] = []
    window.addEventListener('keyup', (event) => seen.push(event), { capture: true })
    for (const handler of native.commitHandlers) {
      handler({ browserPageId: 'page-1' })
    }
    expect(seen.map((event) => [event.type, event.key, event.code])).toEqual([
      ['keyup', 'Control', 'ControlLeft']
    ])
  })

  it('installs only once across repeated calls', async () => {
    const { installTauriBrowserGuestCtrlTabCommit } =
      await import('./tauri-native-browser-guest-shortcut')
    installTauriBrowserGuestCtrlTabCommit()
    installTauriBrowserGuestCtrlTabCommit()
    expect(native.commitHandlers.length).toBe(1)
  })
})
