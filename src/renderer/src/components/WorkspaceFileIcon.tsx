import { getJetBrainsFileIcon } from '@/lib/jetbrains-file-icons'

export function WorkspaceFileIcon({
  path,
  directory = false
}: {
  path: string
  directory?: boolean
}): React.JSX.Element {
  const icon = getJetBrainsFileIcon(path, directory)
  return (
    <span aria-hidden="true" className="relative size-4 shrink-0" data-workspace-file-icon="">
      <img src={icon.light} alt="" className="block size-4 dark:hidden" draggable={false} />
      <img src={icon.dark} alt="" className="hidden size-4 dark:block" draggable={false} />
    </span>
  )
}
