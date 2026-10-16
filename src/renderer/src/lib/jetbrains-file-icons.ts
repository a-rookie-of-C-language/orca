import darkTheme from '@/assets/jetbrains-icons/theme-dark.json'
import lightTheme from '@/assets/jetbrains-icons/theme-light.json'
import { basename } from './path'

type IconTheme = {
  iconDefinitions: Record<string, { iconPath: string }>
  file: string
  folder: string
  folderNames: Record<string, string>
  fileNames: Record<string, string>
  fileExtensions: Record<string, string>
}

const iconAssets = import.meta.glob<string>('../assets/jetbrains-icons/icons/*.svg', {
  eager: true,
  query: '?url',
  import: 'default'
})

function createIconResolver(theme: IconTheme): (path: string, directory: boolean) => string {
  const names = (entries: Record<string, string>) =>
    new Map(Object.entries(entries).map(([name, icon]) => [name.toLowerCase(), icon]))
  const fileNames = names(theme.fileNames)
  const folderNames = names(theme.folderNames)
  const extensions = names(theme.fileExtensions)
  const icons = new Map(
    Object.entries(theme.iconDefinitions).map(([id, definition]) => [
      id,
      iconAssets[`../assets/jetbrains-icons/${definition.iconPath.replace(/^\.\//, '')}`]
    ])
  )

  return (path, directory) => {
    const name = basename(path).toLowerCase()
    let id = directory ? folderNames.get(name) : fileNames.get(name)
    if (!directory && !id) {
      // VS Code tries the longest extension first, including compound suffixes.
      for (let dot = name.indexOf('.'); dot >= 0; dot = name.indexOf('.', dot + 1)) {
        id = extensions.get(name.slice(dot + 1))
        if (id) {
          break
        }
      }
    }
    return icons.get(id ?? (directory ? theme.folder : theme.file)) ?? ''
  }
}

const resolveLightIcon = createIconResolver(lightTheme)
const resolveDarkIcon = createIconResolver(darkTheme)

export function getJetBrainsFileIcon(
  path: string,
  directory = false
): { light: string; dark: string } {
  return { light: resolveLightIcon(path, directory), dark: resolveDarkIcon(path, directory) }
}
