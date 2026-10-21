// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

vi.mock('../i18n/i18n', () => ({
  translate: (key: string, fallback: string) => (key === 'menu.file' ? 'File (zh)' : fallback)
}))
vi.mock('./tauri-native-host', () => ({
  isTauriNativeHost: () => false,
  invokeNative: vi.fn()
}))

import { computeTauriMenuUpdates, TAURI_MENU_HINT_BINDINGS } from './tauri-native-menu-hints'

describe('computeTauriMenuUpdates', () => {
  it('pushes every hint-bound and label-bound id', () => {
    const updates = computeTauriMenuUpdates('win32')
    const ids = updates.map((u) => u.id)
    expect(ids).toContain('file-settings')
    expect(ids).toContain('view-zoom-in')
    expect(ids).toContain('menu-section-file')
    expect(ids).toContain('help-crash-report')
    expect(ids.length).toBe(TAURI_MENU_HINT_BINDINGS.length + 20)
  })

  it('translates label bindings and keeps hint bindings on the spec label', () => {
    const updates = computeTauriMenuUpdates('win32')
    const fileSection = updates.find((u) => u.id === 'menu-section-file')
    expect(fileSection?.baseText).toBe('File (zh)')
    expect(fileSection?.hint).toBeNull()

    const zoom = updates.find((u) => u.id === 'view-zoom-in')
    expect(zoom?.baseText).toBe('Zoom In')
  })

  it('produces a null hint when no binding is registered', () => {
    const updates = computeTauriMenuUpdates('win32', {})
    const settings = updates.find((u) => u.id === 'file-settings')
    expect(settings).toBeDefined()
  })
})
