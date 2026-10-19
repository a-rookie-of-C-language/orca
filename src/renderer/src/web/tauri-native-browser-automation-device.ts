import type { AutomationCommandContext } from './tauri-native-browser-automation'
import { requireString } from './tauri-native-browser-automation'

// Named device presets for `browser.setDevice`, mirroring `agent-browser set
// device`. The preset table lives in the external CLI, so this module pins a
// curated subset transcribed from playwright-core 1.63 device descriptors
// (viewport dims, scale factor, mobile/touch flags, UA). Names outside the
// table stay fail-closed instead of guessing metrics.

type DevicePreset = {
  width: number
  height: number
  deviceScaleFactor: number
  mobile: boolean
  touch: boolean
  userAgent: string
}

const DEVICE_PRESETS: Record<string, DevicePreset> = {
  'iPhone 15': {
    width: 393,
    height: 659,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1'
  },
  'iPhone 15 landscape': {
    width: 734,
    height: 343,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1'
  },
  'iPhone 14': {
    width: 390,
    height: 664,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1'
  },
  'Pixel 9': {
    width: 360,
    height: 732,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.4 Mobile Safari/537.36'
  },
  'Pixel 9 landscape': {
    width: 756,
    height: 308,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.4 Mobile Safari/537.36'
  },
  'Galaxy S24': {
    width: 360,
    height: 780,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; SM-S921U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.4 Mobile Safari/537.36'
  },
  'iPad Pro 11': {
    width: 834,
    height: 1194,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 12_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1'
  },
  'iPad Pro 11 landscape': {
    width: 1194,
    height: 834,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 12_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1'
  },
  'Desktop Chrome': {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
    touch: false,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.4 Safari/537.36'
  },
  'Desktop Safari': {
    width: 1280,
    height: 720,
    deviceScaleFactor: 2,
    mobile: false,
    touch: false,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15'
  }
}

export function resolveDevicePreset(name: string): DevicePreset | undefined {
  return DEVICE_PRESETS[name]
}

export async function deviceAutomationSet(
  context: AutomationCommandContext,
  params: Record<string, unknown>
): Promise<{
  device: string
  width: number
  height: number
  deviceScaleFactor: number
  mobile: boolean
}> {
  const name = requireString(params, 'name')
  const preset = resolveDevicePreset(name)
  if (!preset) {
    throw new Error('browser_command_unavailable')
  }
  await context
    .send('Emulation.setDeviceMetricsOverride', {
      width: preset.width,
      height: preset.height,
      deviceScaleFactor: preset.deviceScaleFactor,
      mobile: preset.mobile
    })
    .catch(() => {
      throw new Error('browser_cdp_error')
    })
  await context.send('Emulation.setTouchEmulationEnabled', { enabled: preset.touch }).catch(() => {
    throw new Error('browser_cdp_error')
  })
  await context.send('Network.enable', {}).catch(() => {
    throw new Error('browser_cdp_error')
  })
  await context.send('Network.setUserAgentOverride', { userAgent: preset.userAgent }).catch(() => {
    throw new Error('browser_cdp_error')
  })
  return {
    device: name,
    width: preset.width,
    height: preset.height,
    deviceScaleFactor: preset.deviceScaleFactor,
    mobile: preset.mobile
  }
}
