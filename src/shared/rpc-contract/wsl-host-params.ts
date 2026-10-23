import { z } from 'zod'

export const WslHostAddParams = z.object({
  distro: z.string().min(1),
  startIfStopped: z.boolean().optional()
})

export const WslHostEnvironmentParams = z.object({
  environmentId: z.string().min(1)
})

export const WslHostConnectParams = WslHostEnvironmentParams.extend({
  intent: z.enum(['update', 'force']).optional(),
  force: z.boolean().optional()
})

export const WslHostVisibleWorkParams = z.object({
  environmentIds: z.array(z.string().min(1))
})
