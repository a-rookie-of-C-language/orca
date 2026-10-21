import { z } from 'zod'

/** Mirrors FloatingTerminalCwdRequest: the panel's configured path plus the trust gate. */
export const FloatingTerminalCwdRpcParams = z.object({
  path: z.string().optional(),
  requireTrusted: z.boolean().optional()
})
export type FloatingTerminalCwdRpcParams = z.infer<typeof FloatingTerminalCwdRpcParams>

/** Picker-approved directory to trust for future floating terminal cwds. */
export const TrustFloatingWorkspaceDirectoryParams = z.object({
  dirPath: z.string()
})
export type TrustFloatingWorkspaceDirectoryParams = z.infer<
  typeof TrustFloatingWorkspaceDirectoryParams
>

/** Resolve a picked file into the markdown document Electron would return. */
export const ResolveFloatingMarkdownDocumentParams = z.object({
  filePath: z.string(),
  directory: z.string()
})
export type ResolveFloatingMarkdownDocumentParams = z.infer<
  typeof ResolveFloatingMarkdownDocumentParams
>
