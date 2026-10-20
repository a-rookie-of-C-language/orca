import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBrowserGlobals } from './web-preload-api-test-harness'

type Files = Map<string, string>

// A tiny in-memory host behind __TAURI_INTERNALS__.invoke that emulates the
// two keybindings file commands plus the opener plugin surface.
function installTauriHost(files: Files, home = 'C:\\Users\\tester') {
  const path = `${home}\\.orca\\keybindings.json`
  const opened: string[] = []
  const revealed: string[] = []
  const globals = installBrowserGlobals('Windows')
  const invoke = vi.fn((command: string, args?: Record<string, unknown>) => {
    if (command === 'poc_read_keybindings_file') {
      return Promise.resolve({ path, text: files.has(path) ? files.get(path) : null })
    }
    if (command === 'poc_write_keybindings_file') {
      const text = args?.text as string
      files.set(path, text)
      return Promise.resolve({ path, text })
    }
    if (command === 'plugin:opener|open_path') {
      opened.push(args?.path as string)
      return Promise.resolve(null)
    }
    if (command === 'plugin:opener|reveal_item_in_dir') {
      revealed.push(args?.path as string)
      return Promise.resolve(null)
    }
    return Promise.reject(new Error(`unexpected native call: ${command}`))
  })
  Object.assign(globals.window, { __TAURI_INTERNALS__: { invoke } })
  return { globals, invoke, path, opened, revealed }
}

describe('tauri native keybindings api', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('returns undefined when not a tauri host', async () => {
    installBrowserGlobals('Windows')
    const { createTauriNativeKeybindingsApi } = await import('./tauri-native-keybindings-api')
    expect(createTauriNativeKeybindingsApi()).toBeUndefined()
  })

  it('reports a missing file with the real on-disk path', async () => {
    const files: Files = new Map()
    const { path } = installTauriHost(files)
    const { createTauriNativeKeybindingsApi } = await import('./tauri-native-keybindings-api')
    const api = createTauriNativeKeybindingsApi()!
    const snapshot = await api.get()
    expect(snapshot.exists).toBe(false)
    expect(snapshot.path).toBe(path)
    expect(snapshot.platform).toBe('win32')
    expect(snapshot.overrides).toEqual({})
  })

  it('creates the file on ensureFile and reports exists:true', async () => {
    const files: Files = new Map()
    const { path } = installTauriHost(files)
    const { createTauriNativeKeybindingsApi } = await import('./tauri-native-keybindings-api')
    const api = createTauriNativeKeybindingsApi()!
    const snapshot = await api.ensureFile()
    expect(snapshot.exists).toBe(true)
    expect(files.has(path)).toBe(true)
    const document = JSON.parse(files.get(path)!) as { version: number; platforms: object }
    expect(document.version).toBe(1)
    expect(document.platforms).toEqual({ darwin: {}, linux: {}, win32: {} })
  })

  it('persists an override into the active platform section', async () => {
    const files: Files = new Map()
    const { path } = installTauriHost(files)
    const { createTauriNativeKeybindingsApi } = await import('./tauri-native-keybindings-api')
    const api = createTauriNativeKeybindingsApi()!
    const snapshot = await api.setAction({
      actionId: 'worktree.palette',
      bindings: ['Ctrl+Alt+J']
    })
    expect(snapshot.overrides['worktree.palette']).toEqual(['Ctrl+Alt+J'])
    const document = JSON.parse(files.get(path)!) as {
      platforms: { win32: Record<string, string[]> }
    }
    expect(document.platforms.win32['worktree.palette']).toEqual(['Ctrl+Alt+J'])
  })

  it('rejects a conflicting binding before writing', async () => {
    const files: Files = new Map()
    const { path } = installTauriHost(files)
    const { createTauriNativeKeybindingsApi } = await import('./tauri-native-keybindings-api')
    const api = createTauriNativeKeybindingsApi()!
    await api.setAction({ actionId: 'worktree.palette', bindings: ['Ctrl+Alt+J'] })
    await expect(
      api.setAction({ actionId: 'worktree.quickOpen', bindings: ['Ctrl+Alt+J'] })
    ).rejects.toThrow('conflicts')
    const document = JSON.parse(files.get(path)!) as {
      platforms: { win32: Record<string, string[]> }
    }
    expect(document.platforms.win32['worktree.quickOpen']).toBeUndefined()
  })

  it('parses existing file contents like Electron readKeybindingFile', async () => {
    const files: Files = new Map()
    const { path } = installTauriHost(files)
    files.set(
      path,
      JSON.stringify({
        version: 1,
        keybindings: {},
        platforms: { win32: { 'worktree.palette': 'Ctrl+Shift+P' }, darwin: {}, linux: {} }
      })
    )
    const { createTauriNativeKeybindingsApi } = await import('./tauri-native-keybindings-api')
    const api = createTauriNativeKeybindingsApi()!
    const snapshot = await api.get()
    expect(snapshot.exists).toBe(true)
    expect(snapshot.overrides['worktree.palette']).toEqual(['Ctrl+Shift+P'])
  })

  it('surfaces a parse error as diagnostics without overwriting the file', async () => {
    const files: Files = new Map()
    const { path } = installTauriHost(files)
    files.set(path, '{not json')
    const { createTauriNativeKeybindingsApi } = await import('./tauri-native-keybindings-api')
    const api = createTauriNativeKeybindingsApi()!
    const snapshot = await api.get()
    expect(snapshot.exists).toBe(true)
    expect(snapshot.diagnostics.some((d) => d.severity === 'error')).toBe(true)
    // And a write refuses to clobber the unreadable user file.
    await expect(
      api.setAction({ actionId: 'worktree.palette', bindings: ['Ctrl+Alt+J'] })
    ).rejects.toThrow()
    expect(files.get(path)).toBe('{not json')
  })

  it('openFile and revealFile ensure the file then call the opener plugin', async () => {
    const files: Files = new Map()
    const { path, opened, revealed } = installTauriHost(files)
    const { createTauriNativeKeybindingsApi } = await import('./tauri-native-keybindings-api')
    const api = createTauriNativeKeybindingsApi()!
    await api.openFile()
    expect(opened).toEqual([path])
    await api.revealFile()
    expect(revealed).toEqual([path])
    expect(files.has(path)).toBe(true)
  })
})
