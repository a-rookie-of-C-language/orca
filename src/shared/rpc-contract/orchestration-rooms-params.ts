import { z } from 'zod'
import { OptionalString, requiredString } from './rpc-param-primitives'

export const RoomMemberInput = z.object({
  memberId: requiredString('Missing member id'),
  name: requiredString('Missing member name'),
  isAdmin: z.boolean().optional()
})

export const RoomCreateParams = z.object({
  name: requiredString('Missing --name'),
  mode: z.enum(['admin', 'everyone']).optional(),
  notice: OptionalString,
  members: z.array(RoomMemberInput).optional()
})

export const RoomListParams = z.object({})

export const RoomShowParams = z.object({
  id: OptionalString,
  name: OptionalString
})

export const RoomDeleteParams = z.object({
  id: requiredString('Missing --id')
})

export const RoomMemberAddParams = z.object({
  id: requiredString('Missing --id'),
  memberId: requiredString('Missing --member-id'),
  name: requiredString('Missing --name'),
  isAdmin: z.boolean().optional()
})

export const RoomMemberRemoveParams = z.object({
  id: requiredString('Missing --id'),
  memberId: requiredString('Missing --member-id')
})

export const RoomSendParams = z.object({
  id: OptionalString,
  name: OptionalString,
  text: requiredString('Missing --text'),
  from: OptionalString
})

export const RoomPostParams = z.object({
  id: requiredString('Missing --id'),
  memberId: requiredString('Missing --member-id'),
  text: requiredString('Missing --text')
})

export const RoomLogParams = z.object({
  id: requiredString('Missing --id'),
  memberId: OptionalString,
  limit: z.number().int().min(1).max(200).optional()
})
