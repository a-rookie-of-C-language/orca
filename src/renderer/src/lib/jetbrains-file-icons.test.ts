import { describe, expect, it } from 'vitest'
import darkTheme from '@/assets/jetbrains-icons/theme-dark.json'
import lightTheme from '@/assets/jetbrains-icons/theme-light.json'
import { getJetBrainsFileIcon } from './jetbrains-file-icons'

const assets = import.meta.glob<string>('../assets/jetbrains-icons/icons/*.svg', {
  eager: true,
  query: '?url',
  import: 'default'
})

describe('JetBrains file icons', () => {
  it.each([
    ['src/index.ts', 'file_typescript'],
    ['src/App.tsx', 'file_tsx'],
    ['src/index.test.ts', 'file_test_ts'],
    ['src/index.test.tsx', 'file_test_tsx'],
    ['package.json', 'file_json'],
    ['README.md', 'file_markdown'],
    ['.gitignore', 'file_gitignore'],
    ['Dockerfile', 'file_docker'],
    ['unknown.orca-unknown', 'file_text']
  ])('resolves %s using the upstream mapping', (path, iconId) => {
    const icon = getJetBrainsFileIcon(path)
    for (const [theme, url] of [
      [lightTheme, icon.light],
      [darkTheme, icon.dark]
    ] as const) {
      const definition = new Map(Object.entries(theme.iconDefinitions)).get(iconId)
      expect(definition).toBeDefined()
      const asset = `../assets/jetbrains-icons/${definition?.iconPath.replace(/^\.\//, '')}`
      expect(url).toBe(assets[asset])
    }
  })

  it('prefers exact filenames, then compound extensions, then the final extension', () => {
    expect(getJetBrainsFileIcon('README')).toEqual(getJetBrainsFileIcon('README.md'))
    expect(getJetBrainsFileIcon('a.test.ts')).not.toEqual(getJetBrainsFileIcon('a.ts'))
    expect(getJetBrainsFileIcon('a.other.ts')).toEqual(getJetBrainsFileIcon('a.ts'))
  })

  it('uses the same icons on native, WSL, SSH and folder workspace paths', () => {
    const icon = getJetBrainsFileIcon('/home/project/src/App.TSX')
    expect(getJetBrainsFileIcon('C:\\project\\src\\App.tsx')).toEqual(icon)
    expect(getJetBrainsFileIcon('src/App.tsx')).toEqual(icon)
  })

  it('resolves named folders separately from files and file extensions', () => {
    expect(getJetBrainsFileIcon('__fixtures__', true)).toEqual(getJetBrainsFileIcon('tests', true))
    expect(getJetBrainsFileIcon('.github', true)).not.toEqual(getJetBrainsFileIcon('src', true))
    expect(getJetBrainsFileIcon('example.ts', true)).toEqual(getJetBrainsFileIcon('src', true))
    expect(getJetBrainsFileIcon('src', true)).not.toEqual(getJetBrainsFileIcon('src'))
  })

  it('does not interpret object prototype names as icon definitions', () => {
    for (const name of ['constructor', '__proto__', 'toString']) {
      expect(getJetBrainsFileIcon(name)).toEqual(getJetBrainsFileIcon('unknown'))
    }
  })

  it('bundles every upstream icon definition and association for both themes', () => {
    for (const theme of [lightTheme, darkTheme]) {
      const definitions = new Map(Object.entries(theme.iconDefinitions))
      for (const definition of definitions.values()) {
        const path = `../assets/jetbrains-icons/${definition.iconPath.replace(/^\.\//, '')}`
        expect(assets[path], path).toBeTruthy()
      }
      for (const id of [
        theme.file,
        theme.folder,
        ...Object.values(theme.fileNames),
        ...Object.values(theme.folderNames),
        ...Object.values(theme.fileExtensions)
      ]) {
        expect(definitions.has(id), id).toBe(true)
      }
    }
  })
})
