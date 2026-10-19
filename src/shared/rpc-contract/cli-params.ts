import { z } from 'zod'
import { OptionalString } from './rpc-param-primitives'

/** Optional WSL distro selector shared by local desktop and Tauri clients. */
export const CliWslInstall = z.object({
  distro: OptionalString.nullable()
})
