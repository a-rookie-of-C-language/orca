import type { AutomationCommandContext } from './tauri-native-browser-automation'
import {
  evaluatePageExpression,
  isRecord,
  readNumber,
  readString
} from './tauri-native-browser-automation'

export async function evalAutomationExpression(
  context: AutomationCommandContext,
  expression: string
): Promise<{ result: string; origin: string }> {
  const value = await evaluatePageExpression(context.send, expression)
  let result = ''
  try {
    const text = JSON.stringify(value)
    result = typeof text === 'string' ? text : String(value)
  } catch {
    result = String(value)
  }
  if (result.length > 8000) {
    result = result.slice(0, 8000)
  }
  const info = await evaluatePageExpression(context.send, '(() => location.href)()')
  const origin = typeof info === 'string' ? info : ''
  return { result, origin }
}

export async function findAutomationText(
  context: AutomationCommandContext,
  locator: string,
  value: string
): Promise<{ found: boolean }> {
  if (locator === 'text') {
    const found = await evaluatePageExpression(
      context.send,
      `(() => window.find(${JSON.stringify(value)}))()`
    )
    return { found: found === true }
  }
  const count = await evaluatePageExpression(
    context.send,
    `(() => document.querySelectorAll(${JSON.stringify(value)}).length)()`
  )
  return { found: typeof count === 'number' && count > 0 }
}

export async function getAutomationProperty(
  context: AutomationCommandContext,
  what: string,
  selector?: string
): Promise<{ result: unknown }> {
  if (!selector) {
    if (what === 'title') {
      return { result: await evaluatePageExpression(context.send, '(() => document.title)()') }
    }
    if (what === 'url') {
      return { result: await evaluatePageExpression(context.send, '(() => location.href)()') }
    }
    if (what === 'text') {
      return {
        result: await evaluatePageExpression(context.send, '(() => document.body.innerText)()')
      }
    }
    throw new Error('browser_invalid_params')
  }
  const escaped = JSON.stringify(selector)
  if (what.startsWith('attr:')) {
    const attribute = what.slice('attr:'.length)
    return {
      result: await evaluatePageExpression(
        context.send,
        `(() => { const el = document.querySelector(${escaped}); return el ? el.getAttribute(${JSON.stringify(attribute)}) : null; })()`
      )
    }
  }
  if (what === 'html' || what === 'outerHTML') {
    return {
      result: await evaluatePageExpression(
        context.send,
        `(() => { const el = document.querySelector(${escaped}); return el ? el.outerHTML : null; })()`
      )
    }
  }
  if (what === 'value') {
    return {
      result: await evaluatePageExpression(
        context.send,
        `(() => { const el = document.querySelector(${escaped}); return el && 'value' in el ? el.value : null; })()`
      )
    }
  }
  return {
    result: await evaluatePageExpression(
      context.send,
      `(() => { const el = document.querySelector(${escaped}); return el ? el.innerText : null; })()`
    )
  }
}

export async function isAutomationState(
  context: AutomationCommandContext,
  what: string,
  selector: string
): Promise<{ matches: boolean }> {
  const escaped = JSON.stringify(selector)
  const expression = (() => {
    switch (what) {
      case 'visible':
        return `(() => { const el = document.querySelector(${escaped}); if (!el) return false; const rect = el.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; })()`
      case 'hidden':
        return `(() => { const el = document.querySelector(${escaped}); if (!el) return true; const rect = el.getBoundingClientRect(); return rect.width === 0 || rect.height === 0; })()`
      case 'enabled':
        return `(() => { const el = document.querySelector(${escaped}); return Boolean(el) && !el.disabled; })()`
      case 'disabled':
        return `(() => { const el = document.querySelector(${escaped}); return Boolean(el) && Boolean(el.disabled); })()`
      case 'checked':
        return `(() => { const el = document.querySelector(${escaped}); return Boolean(el) && Boolean(el.checked); })()`
      case 'focused':
        return `(() => document.activeElement === document.querySelector(${escaped}))()`
      default:
        return null
    }
  })()
  if (!expression) {
    throw new Error('browser_invalid_params')
  }
  const matches = await evaluatePageExpression(context.send, expression)
  return { matches: matches === true }
}

export async function highlightAutomationSelector(
  context: AutomationCommandContext,
  selector: string
): Promise<{ highlighted: string; count: number }> {
  const count = await evaluatePageExpression(
    context.send,
    `(() => { const nodes = document.querySelectorAll(${JSON.stringify(selector)}); nodes.forEach((el) => { el.style.outline = '2px solid #f59e0b'; }); return nodes.length; })()`
  )
  if (typeof count !== 'number' || count === 0) {
    throw new Error('browser_ref_not_found')
  }
  return { highlighted: selector, count }
}

export async function storageAutomationGet(
  context: AutomationCommandContext,
  area: 'local' | 'session',
  key?: string
): Promise<{ result: unknown }> {
  const store = area === 'local' ? 'localStorage' : 'sessionStorage'
  if (key) {
    return {
      result: await evaluatePageExpression(
        context.send,
        `(() => window.${store}.getItem(${JSON.stringify(key)}))()`
      )
    }
  }
  const dump = await evaluatePageExpression(
    context.send,
    `(() => { const out = {}; for (let i = 0; i < window.${store}.length; i++) { const k = window.${store}.key(i); if (k) out[k] = window.${store}.getItem(k); } return out; })()`
  )
  return { result: isRecord(dump) ? dump : {} }
}

export async function storageAutomationSet(
  context: AutomationCommandContext,
  area: 'local' | 'session',
  key: string,
  value: string
): Promise<{ success: boolean }> {
  const store = area === 'local' ? 'localStorage' : 'sessionStorage'
  await evaluatePageExpression(
    context.send,
    `(() => window.${store}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)}))()`
  )
  return { success: true }
}

export async function storageAutomationClear(
  context: AutomationCommandContext,
  area: 'local' | 'session'
): Promise<{ cleared: boolean }> {
  const store = area === 'local' ? 'localStorage' : 'sessionStorage'
  await evaluatePageExpression(context.send, `(() => window.${store}.clear())()`)
  return { cleared: true }
}

export async function clipboardAutomationRead(
  context: AutomationCommandContext
): Promise<{ text: string }> {
  try {
    const text = await evaluatePageExpression(
      context.send,
      '(() => navigator.clipboard.readText())()'
    )
    return { text: typeof text === 'string' ? text : '' }
  } catch {
    throw new Error('browser_command_unavailable')
  }
}

export async function clipboardAutomationWrite(
  context: AutomationCommandContext,
  text: string
): Promise<{ written: boolean }> {
  try {
    await evaluatePageExpression(
      context.send,
      `(() => navigator.clipboard.writeText(${JSON.stringify(text)}))()`
    )
  } catch {
    throw new Error('browser_command_unavailable')
  }
  return { written: true }
}

export async function dialogAutomationHandle(
  context: AutomationCommandContext,
  accept: boolean,
  promptText?: string
): Promise<{ handled: boolean }> {
  const args: Record<string, unknown> = { accept }
  if (promptText !== undefined) {
    args.promptText = promptText
  }
  await context.send('Page.handleJavaScriptDialog', args).catch(() => {
    throw new Error('browser_command_unavailable')
  })
  return { handled: true }
}

async function checkWaitCondition(
  context: AutomationCommandContext,
  params: Record<string, unknown>
): Promise<boolean> {
  const selector = readString(params, 'selector')
  if (selector) {
    const state = readString(params, 'state')
    const present = await evaluatePageExpression(
      context.send,
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'missing'; const rect = el.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 ? 'visible' : 'hidden'; })()`
    )
    if (state === 'hidden' || state === 'detached') {
      return present === 'hidden' || present === 'missing'
    }
    return present === 'visible'
  }
  const text = readString(params, 'text')
  if (text) {
    const body = await evaluatePageExpression(context.send, '(() => document.body.innerText)()')
    return typeof body === 'string' && body.includes(text)
  }
  const url = readString(params, 'url')
  if (url) {
    const href = await evaluatePageExpression(context.send, '(() => location.href)()')
    return typeof href === 'string' && href.includes(url)
  }
  const load = readString(params, 'load')
  if (load) {
    const ready = await evaluatePageExpression(context.send, '(() => document.readyState)()')
    return ready === 'complete'
  }
  const fn = readString(params, 'fn')
  if (fn) {
    const outcome = await evaluatePageExpression(
      context.send,
      `(() => { try { return Boolean(${fn}); } catch { return false; } })()`
    )
    return outcome === true
  }
  return true
}

export async function waitAutomationCondition(
  context: AutomationCommandContext,
  params: Record<string, unknown>
): Promise<{ waited: boolean }> {
  const timeout = readNumber(params, 'timeout') ?? 15000
  const deadline = Date.now() + Math.min(Math.max(timeout, 0), 120000)
  for (;;) {
    const satisfied = await checkWaitCondition(context, params).catch(() => false)
    if (satisfied) {
      return { waited: true }
    }
    if (Date.now() >= deadline) {
      throw new Error('browser_timeout')
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 250)
    })
  }
}
