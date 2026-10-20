import { z } from 'zod'
import { requiredString } from './rpc-param-primitives'

const SessionId = z.string().min(1).max(256)

export const SpeechDesktopStart = z.object({
  modelId: requiredString('Missing model ID'),
  hotwords: z.array(z.string().min(1).max(256)).max(256).optional(),
  sessionId: SessionId
})

export const SpeechDesktopAudio = z.object({
  sessionId: SessionId,
  audioBase64: z.string().min(1, 'Missing audio chunk').max(1_800_000),
  sampleRate: z.number().finite().positive()
})

export const SpeechDesktopSession = z.object({ sessionId: SessionId })

export const SpeechDesktopModelAction = z.object({
  modelId: requiredString('Missing model ID')
})

export const SpeechDesktopApiKey = z.object({
  apiKey: z.string().min(1).max(4096)
})

export const SpeechDesktopEventsUnsubscribe = z.object({
  subscriptionId: requiredString('Missing subscription ID')
})
