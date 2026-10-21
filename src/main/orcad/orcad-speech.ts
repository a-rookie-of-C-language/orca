import { ModelManager } from '../speech/model-manager'
import { openNodeSpeechDownloadRequest } from '../speech/node-speech-download-request'
import { setSpeechServiceFactories } from '../speech/speech-runtime-service'
import { SttService } from '../speech/stt-service'

/** Installs the speech services without importing Electron into the orcad process. */
export function installOrcadSpeechServices(): void {
  setSpeechServiceFactories({
    createModelManager: (customModelsDir) =>
      new ModelManager(customModelsDir, openNodeSpeechDownloadRequest),
    createSttService: (models) => new SttService(models)
  })
}
