import { invokeNative } from './tauri-native-host'
import type { AutomationCommandContext } from './tauri-native-browser-automation'
import {
  evaluatePageExpression,
  isRecord,
  normalizeAutomationNavigationUrl,
  readAutomationPageInfo,
  readBoolean,
  readNumber,
  readString,
  requireString
} from './tauri-native-browser-automation'

async function invokePageCommand<T>(command: string, args: Record<string, unknown>): Promise<T> {
  return invokeNative<T>(command, { args }).catch(() => {
    throw new Error('browser_cdp_error')
  })
}

export async function gotoAutomationPage(
  context: AutomationCommandContext,
  url: string
): Promise<{ url: string; title: string }> {
  const normalized = normalizeAutomationNavigationUrl(url)
  await invokePageCommand('poc_browser_navigate', {
    browserPageId: context.browserPageId,
    url: normalized
  })
  const info = readAutomationPageInfo(context.browserPageId)
  return { url: info.url || normalized, title: info.title }
}

export async function goBackAutomationPage(
  context: AutomationCommandContext
): Promise<{ url: string; title: string }> {
  await invokePageCommand('poc_browser_go_back', { browserPageId: context.browserPageId })
  return readAutomationPageInfo(context.browserPageId)
}

export async function goForwardAutomationPage(
  context: AutomationCommandContext
): Promise<{ url: string; title: string }> {
  await invokePageCommand('poc_browser_go_forward', { browserPageId: context.browserPageId })
  return readAutomationPageInfo(context.browserPageId)
}

export async function reloadAutomationPage(
  context: AutomationCommandContext
): Promise<{ url: string; title: string }> {
  await invokePageCommand('poc_browser_reload', { browserPageId: context.browserPageId })
  return readAutomationPageInfo(context.browserPageId)
}

export async function proceedAutomationCertificate(
  context: AutomationCommandContext,
  params: Record<string, unknown>
): Promise<{ proceeded: boolean }> {
  const challengeId = requireString(params, 'challengeId')
  const result = await invokePageCommand<unknown>('poc_browser_proceed_certificate', {
    browserPageId: context.browserPageId,
    challengeId
  })
  if (isRecord(result) && result.ok === false) {
    throw new Error('browser_certificate_trust_unavailable')
  }
  return { proceeded: true }
}

export async function screenshotAutomationPage(
  context: AutomationCommandContext,
  fullPage: boolean,
  format?: string
): Promise<{ data: string; format: 'png' | 'jpeg' }> {
  const resolvedFormat = format === 'jpeg' ? 'jpeg' : 'png'
  const response = await context
    .send('Page.captureScreenshot', {
      format: resolvedFormat,
      quality: resolvedFormat === 'jpeg' ? 80 : undefined,
      captureBeyondViewport: fullPage,
      fromSurface: true
    })
    .catch(() => {
      throw new Error('browser_cdp_error')
    })
  if (!isRecord(response) || typeof response.data !== 'string') {
    throw new Error('browser_cdp_error')
  }
  return { data: response.data, format: resolvedFormat }
}

export async function pdfAutomationPage(
  context: AutomationCommandContext
): Promise<{ data: string }> {
  const response = await context
    .send('Page.printToPDF', {
      printBackground: true
    })
    .catch(() => {
      throw new Error('browser_cdp_error')
    })
  if (!isRecord(response) || typeof response.data !== 'string') {
    throw new Error('browser_cdp_error')
  }
  return { data: response.data }
}

type BrowserCookieShape = {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: string
}

function normalizeCookie(value: unknown): BrowserCookieShape | null {
  if (!isRecord(value)) {
    return null
  }
  if (typeof value.name !== 'string' || typeof value.value !== 'string') {
    return null
  }
  return {
    name: value.name,
    value: value.value,
    domain: typeof value.domain === 'string' ? value.domain : '',
    path: typeof value.path === 'string' ? value.path : '/',
    expires: typeof value.expires === 'number' ? value.expires : 0,
    httpOnly: value.httpOnly === true,
    secure: value.secure === true,
    sameSite: typeof value.sameSite === 'string' ? value.sameSite : 'Lax'
  }
}

export async function cookiesAutomationGet(
  context: AutomationCommandContext,
  url?: string
): Promise<{ cookies: BrowserCookieShape[] }> {
  const info = readAutomationPageInfo(context.browserPageId)
  const targetUrl = url ?? info.url
  const response = await context
    .send('Storage.getCookies', {
      browserContextId: undefined
    })
    .catch(() => {
      throw new Error('browser_cdp_error')
    })
  void targetUrl
  if (!isRecord(response) || !Array.isArray(response.cookies)) {
    throw new Error('browser_cdp_error')
  }
  const cookies: BrowserCookieShape[] = []
  for (const raw of response.cookies) {
    const cookie = normalizeCookie(raw)
    if (cookie) {
      cookies.push(cookie)
    }
  }
  return { cookies }
}

export async function cookieAutomationSet(
  context: AutomationCommandContext,
  params: Record<string, unknown>
): Promise<{ success: boolean }> {
  const name = requireString(params, 'name')
  const value = requireString(params, 'value')
  const info = readAutomationPageInfo(context.browserPageId)
  const cookie: Record<string, unknown> = { name, value, url: info.url }
  const domain = readString(params, 'domain')
  if (domain !== undefined) {
    cookie.domain = domain
  }
  const path = readString(params, 'path')
  if (path !== undefined) {
    cookie.path = path
  }
  const secure = readBoolean(params, 'secure')
  if (secure !== undefined) {
    cookie.secure = secure
  }
  const httpOnly = readBoolean(params, 'httpOnly')
  if (httpOnly !== undefined) {
    cookie.httpOnly = httpOnly
  }
  const sameSite = readString(params, 'sameSite')
  if (sameSite !== undefined) {
    cookie.sameSite = sameSite
  }
  const expires = readNumber(params, 'expires')
  if (expires !== undefined) {
    cookie.expires = expires
  }
  const response = await context.send('Storage.setCookies', { cookies: [cookie] }).catch(() => {
    throw new Error('browser_cdp_error')
  })
  // WebView2 answers Storage.setCookies with {} on success (no success flag), so only an explicit denial fails. Transport/CDP errors already threw above.
  if (!isRecord(response) || response.success === false) {
    throw new Error('browser_cdp_error')
  }
  return { success: true }
}

export async function cookieAutomationDelete(
  context: AutomationCommandContext,
  params: Record<string, unknown>
): Promise<{ deleted: boolean }> {
  const name = requireString(params, 'name')
  const info = readAutomationPageInfo(context.browserPageId)
  const args: Record<string, unknown> = { cookieName: name, url: info.url }
  const domain = readString(params, 'domain')
  if (domain !== undefined) {
    args.domain = domain
  }
  const cleared = await context.send('Storage.deleteCookies', args).then(
    () => true,
    () => false
  )
  if (!cleared) {
    // WebView2 rejects Storage.deleteCookies, so expire the cookie in-page.
    // This only clears non-httpOnly cookies, which covers this engine's sets.
    const expired = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`
    await evaluatePageExpression(
      context.send,
      `(() => { document.cookie = ${JSON.stringify(expired)}; return true; })()`
    ).catch(() => {
      throw new Error('browser_cdp_error')
    })
  }
  return { deleted: true }
}
