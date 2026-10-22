import { z } from 'zod'

export const MobilePairingQrParams = z
  .object({
    address: z.string().trim().min(1).optional(),
    connectionMode: z.enum(['automatic', 'local-only']).optional(),
    rotate: z.boolean().optional()
  })
  .strict()

export const MobileRuntimePairingUrlParams = z
  .object({
    address: z.string().trim().min(1).optional(),
    rotate: z.boolean().optional(),
    reach: z.enum(['this-computer', 'network']).optional()
  })
  .strict()

export const MobileDeviceIdParams = z.object({
  deviceId: z.string().trim().min(1)
})

export const OrcaProfileSelectOrgParams = z.object({
  orgId: z.string().trim().min(1)
})

export const OrcaProfileCreateCloudLinkedParams = z
  .object({
    orgId: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional()
  })
  .strict()
