import { ModelManager } from '../speech/model-manager'
import { SttService } from '../speech/stt-service'
import type { SpeechServiceFactories } from '../speech/speech-runtime-service'
import { createElectronSpeechModelDownloadRequest } from './electron-speech-model-download-request'

/** The desktop speech factories. Importing this file is what pulls Electron's net in. */
export const electronSpeechServiceFactories: SpeechServiceFactories = {
  createModelManager: (customModelsDir) =>
    new ModelManager(customModelsDir, createElectronSpeechModelDownloadRequest),
  createSttService: (models) => new SttService(models)
}
