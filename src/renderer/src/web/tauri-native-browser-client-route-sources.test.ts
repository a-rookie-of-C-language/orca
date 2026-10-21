// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  readTauriClientRouteImportSources,
  recordTauriClientRouteImportSource,
  resetTauriClientRouteImportSourcesForTest,
  sanitizeClientRouteSources
} from './tauri-native-browser-client-route-sources'

beforeEach(() => {
  resetTauriClientRouteImportSourcesForTest()
})

describe('Tauri client-route import sources', () => {
  it('round-trips badges per environment', () => {
    recordTauriClientRouteImportSource('env-1', 'default', {
      browserFamily: 'chrome',
      profileName: 'Default',
      importedAt: 7
    })
    expect(readTauriClientRouteImportSources('env-1')).toEqual({
      default: expect.objectContaining({ browserFamily: 'chrome' })
    })
    expect(readTauriClientRouteImportSources('env-2')).toEqual({})
  })

  it('drops invalid families when sanitizing native payloads', () => {
    expect(
      sanitizeClientRouteSources({
        good: { browserFamily: 'firefox', importedAt: 3 },
        bad: { browserFamily: 'netscape', importedAt: 4 }
      })
    ).toEqual({ good: expect.objectContaining({ browserFamily: 'firefox' }) })
    expect(sanitizeClientRouteSources(null)).toEqual({})
  })

  it('evicts oldest badges beyond the 128 cap', () => {
    for (let index = 0; index < 138; index += 1) {
      recordTauriClientRouteImportSource('env-1', `profile-${index}`, {
        browserFamily: 'chrome',
        importedAt: index
      })
    }
    const listed = readTauriClientRouteImportSources('env-1')
    expect(Object.keys(listed)).toHaveLength(128)
    expect(listed['profile-0']).toBeUndefined()
    expect(listed['profile-137']).toBeDefined()
  })
})
