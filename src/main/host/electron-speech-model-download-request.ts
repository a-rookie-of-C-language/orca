import { net } from 'electron'
import type { DownloadRequest } from '../speech/speech-model-download-response'

/** Keeps Electron's proxy-aware transport at the desktop boundary. */
export function createElectronSpeechModelDownloadRequest(url: URL): DownloadRequest {
  const request = net.request({ method: 'GET', url: url.toString() })
  return {
    abort: () => request.abort(),
    on: (event, listener) => {
      if (event === 'error') {
        request.on('error', listener)
      } else if (event === 'response') {
        request.on('response', listener)
      } else {
        request.on('redirect', listener)
      }
    },
    off: (event, listener) => {
      if (event === 'error') {
        request.off('error', listener)
      } else if (event === 'response') {
        request.off('response', listener)
      } else {
        request.off('redirect', listener)
      }
    },
    setHeader: (name, value) => request.setHeader(name, value),
    end: () => request.end()
  }
}
