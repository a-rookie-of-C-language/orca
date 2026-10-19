import { defineMethod, defineStreamingMethod } from '../core'
import {
  DictationChunk,
  DictationHandle,
  DictationSetup,
  DictationStart,
  SpeechModelAction
} from '../../../../shared/rpc-contract/speech-params'
import {
  SpeechDesktopApiKey,
  SpeechDesktopAudio,
  SpeechDesktopEventsUnsubscribe,
  SpeechDesktopModelAction,
  SpeechDesktopSession,
  SpeechDesktopStart
} from '../../../../shared/rpc-contract/speech-desktop-params'
import { RuntimeDesktopSpeechController } from '../../runtime-desktop-speech-controller'
import type { RuntimeStore } from '../../runtime-store-contract'

const desktopSpeechControllers = new WeakMap<object, RuntimeDesktopSpeechController>()
let desktopSpeechSubscriptionSeq = 0

function requireDesktopSpeechClient(clientKind: 'mobile' | 'runtime' | undefined): void {
  if (clientKind !== 'runtime') {
    throw new Error('speech_desktop_only')
  }
}

function desktopSpeechController(runtime: {
  requireStore(): RuntimeStore
}): RuntimeDesktopSpeechController {
  let controller = desktopSpeechControllers.get(runtime)
  if (!controller) {
    controller = new RuntimeDesktopSpeechController(() => runtime.requireStore())
    desktopSpeechControllers.set(runtime, controller)
  }
  return controller
}

export const SPEECH_METHODS = [
  defineMethod({
    name: 'speech.models.list',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => runtime.listMobileSpeechModels()
  }),
  defineMethod({
    name: 'speech.models.download',
    permission: 'workspace',
    params: SpeechModelAction,
    handler: async (params, { runtime }) => runtime.downloadMobileSpeechModel(params.modelId)
  }),
  defineMethod({
    name: 'speech.models.delete',
    permission: 'workspace',
    params: SpeechModelAction,
    handler: async (params, { runtime }) => runtime.deleteMobileSpeechModel(params.modelId)
  }),
  defineMethod({
    name: 'speech.dictation.setup',
    permission: 'workspace',
    params: DictationSetup,
    handler: async (params, { runtime }) =>
      runtime.configureMobileDictation({
        ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
        ...(params.modelId !== undefined ? { modelId: params.modelId } : {}),
        ...(params.dictationMode !== undefined ? { dictationMode: params.dictationMode } : {})
      })
  }),
  defineMethod({
    name: 'speech.dictation.start',
    permission: 'workspace',
    params: DictationStart,
    handler: async (params, { runtime, clientId, connectionId }) =>
      runtime.startMobileDictation({ ...params, clientId, connectionId })
  }),
  defineMethod({
    name: 'speech.dictation.chunk',
    permission: 'workspace',
    params: DictationChunk,
    handler: (params, { runtime, clientId, connectionId }) =>
      runtime.feedMobileDictation({ ...params, clientId, connectionId })
  }),
  defineMethod({
    name: 'speech.dictation.finish',
    permission: 'workspace',
    params: DictationHandle,
    handler: async (params, { runtime, clientId, connectionId }) =>
      runtime.finishMobileDictation({ ...params, clientId, connectionId })
  }),
  defineMethod({
    name: 'speech.dictation.cancel',
    permission: 'workspace',
    params: DictationHandle,
    handler: async (params, { runtime, clientId, connectionId }) =>
      runtime.cancelMobileDictation({ ...params, clientId, connectionId })
  }),
  defineMethod({
    name: 'speech.desktop.getCatalog',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime, clientKind }) => {
      requireDesktopSpeechClient(clientKind)
      return desktopSpeechController(runtime).catalog()
    }
  }),
  defineMethod({
    name: 'speech.desktop.getModelStates',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime, clientKind }) => {
      requireDesktopSpeechClient(clientKind)
      return desktopSpeechController(runtime).modelStates()
    }
  }),
  defineMethod({
    name: 'speech.desktop.getOpenAiApiKeyStatus',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime, clientKind }) => {
      requireDesktopSpeechClient(clientKind)
      return desktopSpeechController(runtime).apiKeyStatus()
    }
  }),
  defineMethod({
    name: 'speech.desktop.saveOpenAiApiKey',
    permission: 'workspace',
    params: SpeechDesktopApiKey,
    handler: async (params, { runtime, clientKind }) => {
      requireDesktopSpeechClient(clientKind)
      return desktopSpeechController(runtime).saveApiKey(params.apiKey)
    }
  }),
  defineMethod({
    name: 'speech.desktop.clearOpenAiApiKey',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime, clientKind }) => {
      requireDesktopSpeechClient(clientKind)
      return desktopSpeechController(runtime).clearApiKey()
    }
  }),
  defineMethod({
    name: 'speech.desktop.downloadModel',
    permission: 'workspace',
    params: SpeechDesktopModelAction,
    handler: async (params, { runtime, clientKind }) => {
      requireDesktopSpeechClient(clientKind)
      await desktopSpeechController(runtime).downloadModel(params.modelId)
    }
  }),
  defineMethod({
    name: 'speech.desktop.cancelDownload',
    permission: 'workspace',
    params: SpeechDesktopModelAction,
    handler: async (params, { runtime, clientKind }) => {
      requireDesktopSpeechClient(clientKind)
      desktopSpeechController(runtime).cancelDownload(params.modelId)
    }
  }),
  defineMethod({
    name: 'speech.desktop.deleteModel',
    permission: 'workspace',
    params: SpeechDesktopModelAction,
    handler: async (params, { runtime, clientKind }) => {
      requireDesktopSpeechClient(clientKind)
      await desktopSpeechController(runtime).deleteModel(params.modelId)
    }
  }),
  defineStreamingMethod({
    name: 'speech.desktop.events',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime, clientKind, connectionId }, emit) => {
      requireDesktopSpeechClient(clientKind)
      if (!connectionId) {
        throw new Error('speech_requires_runtime_connection')
      }
      const subscriptionId = `speech.desktop.events-${connectionId}-${++desktopSpeechSubscriptionSeq}`
      await new Promise<void>((resolve) => {
        const unsubscribe = desktopSpeechController(runtime).subscribe(emit)
        runtime.registerSubscriptionCleanup(
          subscriptionId,
          () => {
            unsubscribe()
            emit({ type: 'end' })
            resolve()
          },
          connectionId
        )
        emit({ type: 'ready', subscriptionId })
      })
    }
  }),
  defineMethod({
    name: 'speech.desktop.events.unsubscribe',
    permission: 'workspace',
    params: SpeechDesktopEventsUnsubscribe,
    handler: async (params, { runtime, clientKind, connectionId }) => {
      requireDesktopSpeechClient(clientKind)
      const expectedPrefix = `speech.desktop.events-${connectionId ?? 'inproc'}-`
      if (!params.subscriptionId.startsWith(expectedPrefix)) {
        return { unsubscribed: false }
      }
      runtime.cleanupSubscription(params.subscriptionId)
      return { unsubscribed: true }
    }
  }),
  defineMethod({
    name: 'speech.desktop.startDictation',
    permission: 'workspace',
    params: SpeechDesktopStart,
    handler: async (params, { runtime, clientKind, connectionId }) => {
      requireDesktopSpeechClient(clientKind)
      if (!connectionId) {
        throw new Error('speech_requires_runtime_connection')
      }
      await desktopSpeechController(runtime).start(
        connectionId,
        params.sessionId,
        params.modelId,
        params.hotwords,
        (id, cleanup) => runtime.registerSubscriptionCleanup(id, cleanup, connectionId)
      )
    }
  }),
  defineMethod({
    name: 'speech.desktop.feedAudio',
    permission: 'workspace',
    params: SpeechDesktopAudio,
    handler: async (params, { runtime, clientKind, connectionId }) => {
      requireDesktopSpeechClient(clientKind)
      if (!connectionId) {
        throw new Error('speech_requires_runtime_connection')
      }
      desktopSpeechController(runtime).feed(
        connectionId,
        params.sessionId,
        params.audioBase64,
        params.sampleRate
      )
    }
  }),
  defineMethod({
    name: 'speech.desktop.stopDictation',
    permission: 'workspace',
    params: SpeechDesktopSession,
    handler: async (params, { runtime, clientKind, connectionId }) => {
      requireDesktopSpeechClient(clientKind)
      if (!connectionId) {
        throw new Error('speech_requires_runtime_connection')
      }
      await desktopSpeechController(runtime).stop(connectionId, params.sessionId)
      runtime.cleanupSubscription(`speech.desktop.dictation:${connectionId}:${params.sessionId}`)
    }
  })
]
