import { describe, expect, it } from 'vitest'
import { isPairedWebClientWindow, shouldRenderDesktopWindowChrome } from './desktop-window-chrome'

describe('shouldRenderDesktopWindowChrome', () => {
  it('renders custom chrome for frameless desktop Linux and Windows windows', () => {
    expect(shouldRenderDesktopWindowChrome({ platform: 'linux', isWebClient: false })).toBe(true)
    expect(shouldRenderDesktopWindowChrome({ platform: 'win32', isWebClient: false })).toBe(true)
  })

  it('keeps macOS on native traffic lights', () => {
    expect(shouldRenderDesktopWindowChrome({ platform: 'darwin', isWebClient: false })).toBe(false)
  })

  it('does not render desktop-only window controls in the paired web client', () => {
    expect(shouldRenderDesktopWindowChrome({ platform: 'linux', isWebClient: true })).toBe(false)
    expect(shouldRenderDesktopWindowChrome({ platform: 'win32', isWebClient: true })).toBe(false)
  })

  it('treats the Tauri shell as a desktop window rather than a browser tab', () => {
    globalThis.__ORCA_WEB_CLIENT__ = true
    globalThis.__TAURI_INTERNALS__ = { invoke: () => Promise.resolve() }
    expect(isPairedWebClientWindow()).toBe(false)

    delete globalThis.__TAURI_INTERNALS__
    expect(isPairedWebClientWindow()).toBe(true)
    delete globalThis.__ORCA_WEB_CLIENT__
  })
})
