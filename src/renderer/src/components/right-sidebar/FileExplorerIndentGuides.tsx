import { FILE_EXPLORER_INDENT, FILE_EXPLORER_LEFT_PADDING } from './file-explorer-row-layout'

export function FileExplorerIndentGuides({ depth }: { depth: number }): React.JSX.Element | null {
  if (depth <= 0) {
    return null
  }
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0"
      data-file-explorer-indent-guides=""
      style={{
        left: FILE_EXPLORER_LEFT_PADDING + 6,
        width: depth * FILE_EXPLORER_INDENT,
        backgroundImage: 'linear-gradient(to right, var(--border) 1px, transparent 1px)',
        backgroundSize: `${FILE_EXPLORER_INDENT}px 100%`
      }}
    />
  )
}
