import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import type { DownloadIncomingMessage, DownloadRequest } from './speech-model-download-response'

/** Node transport used by orcad/Tauri, where Electron's proxy-aware `net` module is unavailable. */
export function createNodeSpeechModelDownloadRequest(url: URL): DownloadRequest {
  const errors = new Set<(error: Error) => void>()
  const responses = new Set<(response: DownloadIncomingMessage) => void>()
  const redirects = new Set<(statusCode: number, method: string, redirectUrl: string) => void>()

  const request = httpsRequest(
    {
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET'
    },
    (response: IncomingMessage) => {
      const location = response.headers.location
      if (
        response.statusCode !== undefined &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        typeof location === 'string'
      ) {
        response.resume()
        for (const listener of redirects) {
          listener(response.statusCode, 'GET', location)
        }
        return
      }
      for (const listener of responses) {
        listener(response)
      }
    }
  )

  request.on('error', (error) => {
    for (const listener of errors) {
      listener(error)
    }
  })

  return {
    abort: () => request.destroy(),
    on: (event, listener) => {
      if (event === 'error') {
        errors.add(listener)
      } else if (event === 'response') {
        responses.add(listener)
      } else {
        redirects.add(listener)
      }
    },
    off: (event, listener) => {
      if (event === 'error') {
        errors.delete(listener)
      } else if (event === 'response') {
        responses.delete(listener)
      } else {
        redirects.delete(listener)
      }
    },
    setHeader: (name, value) => request.setHeader(name, value),
    end: () => request.end()
  }
}
