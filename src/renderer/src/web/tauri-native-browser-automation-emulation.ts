import type { AutomationCommandContext } from './tauri-native-browser-automation'
import {
  isRecord,
  readBoolean,
  readNumber,
  readString,
  requireString
} from './tauri-native-browser-automation'

export async function viewportAutomationSet(
  context: AutomationCommandContext,
  params: Record<string, unknown>
): Promise<{ width: number; height: number; deviceScaleFactor: number; mobile: boolean }> {
  const width = readNumber(params, 'width')
  const height = readNumber(params, 'height')
  if (width === undefined || height === undefined || width <= 0 || height <= 0) {
    throw new Error('browser_invalid_params')
  }
  const deviceScaleFactor = readNumber(params, 'deviceScaleFactor') ?? 1
  const mobile = readBoolean(params, 'mobile') ?? false
  await context
    .send('Emulation.setDeviceMetricsOverride', {
      width: Math.floor(width),
      height: Math.floor(height),
      deviceScaleFactor,
      mobile
    })
    .catch(() => {
      throw new Error('browser_cdp_error')
    })
  return { width: Math.floor(width), height: Math.floor(height), deviceScaleFactor, mobile }
}

export async function geolocationAutomationSet(
  context: AutomationCommandContext,
  params: Record<string, unknown>
): Promise<{ latitude: number; longitude: number; accuracy: number }> {
  const latitude = readNumber(params, 'latitude')
  const longitude = readNumber(params, 'longitude')
  if (latitude === undefined || longitude === undefined) {
    throw new Error('browser_invalid_params')
  }
  const accuracy = readNumber(params, 'accuracy') ?? 1
  await context
    .send('Emulation.setGeolocationOverride', {
      latitude,
      longitude,
      accuracy
    })
    .catch(() => {
      throw new Error('browser_cdp_error')
    })
  return { latitude, longitude, accuracy }
}

export async function offlineAutomationSet(
  context: AutomationCommandContext,
  params: Record<string, unknown>
): Promise<{ offline: boolean }> {
  const state = readString(params, 'state')
  const offline =
    state === undefined ? true : state !== 'false' && state !== '0' && state !== 'online'
  await context.send('Network.enable', {}).catch(() => {
    throw new Error('browser_cdp_error')
  })
  await context
    .send('Network.emulateNetworkConditions', {
      offline,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1
    })
    .catch(() => {
      throw new Error('browser_cdp_error')
    })
  return { offline }
}

export async function headersAutomationSet(
  context: AutomationCommandContext,
  params: Record<string, unknown>
): Promise<{ headers: Record<string, string> }> {
  const raw = readString(params, 'headers')
  if (raw === undefined) {
    throw new Error('browser_invalid_params')
  }
  let parsed: unknown = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('browser_invalid_params')
  }
  if (!isRecord(parsed)) {
    throw new Error('browser_invalid_params')
  }
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') {
      headers[key] = value
    }
  }
  await context.send('Network.enable', {}).catch(() => {
    throw new Error('browser_cdp_error')
  })
  await context.send('Network.setExtraHTTPHeaders', { headers }).catch(() => {
    throw new Error('browser_cdp_error')
  })
  return { headers }
}

export async function mediaAutomationSet(
  context: AutomationCommandContext,
  params: Record<string, unknown>
): Promise<{ applied: boolean }> {
  const args: Record<string, unknown> = { media: 'screen' }
  const colorScheme = readString(params, 'colorScheme')
  if (colorScheme !== undefined) {
    args.colorScheme = colorScheme
  }
  const reducedMotion = readString(params, 'reducedMotion')
  if (reducedMotion !== undefined) {
    args.reducedMotion = reducedMotion
  }
  await context.send('Emulation.setEmulatedMedia', args).catch(() => {
    throw new Error('browser_cdp_error')
  })
  return { applied: true }
}

export async function credentialsAutomationSet(
  context: AutomationCommandContext,
  params: Record<string, unknown>
): Promise<{ applied: boolean }> {
  // Why preemptive Basic: without a CDP event pipe the host cannot answer
  // auth challenges when they arrive, so the credential rides every request
  // like agent-browser's `set credentials` achieves for basic-auth sites.
  // The result carries no secret, keeping it out of logs and budgets.
  const user = requireString(params, 'user')
  const pass = requireString(params, 'pass')
  if (!user) {
    throw new Error('browser_invalid_params')
  }
  const bytes = new TextEncoder().encode(`${user}:${pass}`)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  const encoded = btoa(binary)
  await context.send('Network.enable', {}).catch(() => {
    throw new Error('browser_cdp_error')
  })
  await context
    .send('Network.setExtraHTTPHeaders', {
      headers: { Authorization: `Basic ${encoded}` }
    })
    .catch(() => {
      throw new Error('browser_cdp_error')
    })
  return { applied: true }
}
