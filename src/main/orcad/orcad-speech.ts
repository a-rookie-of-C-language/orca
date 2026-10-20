import { ModelManager } from '../speech/model-manager'
import { createNodeSpeechModelDownloadRequest } from '../speech/node-speech-model-download-request'
import { setSpeechServiceFactories } from '../speech/speech-runtime-service'
import { SttService } from '../speech/stt-service'

/** Installs the speech services without importing Electron into the orcad process. */
export function installOrcadSpeechServices(): void {
  setSpeechServiceFactories({
    createModelManager: (customModelsDir) =>
      new ModelManager(customModelsDir, createNodeSpeechModelDownloadRequest),
    createSttService: (models) => new SttService(models)
  })
}
