export const FILE_EXPLORER_ROW_HEIGHT = 22
export const FILE_EXPLORER_INDENT = 12
export const FILE_EXPLORER_LEFT_PADDING = 8

export function getFileExplorerRowPadding(depth: number): number {
  return Math.max(0, depth) * FILE_EXPLORER_INDENT + FILE_EXPLORER_LEFT_PADDING
}
