import { invokeNative } from './tauri-native-host'

export type PageFindOptions = {
  forward?: boolean
  findNext?: boolean
  matchCase?: boolean
}

type PageFindState = {
  query: string
  matches: number
  ordinal: number
}

// Structural page surface: NativeBrowserPage satisfies this without importing
// the webview module (which imports this finder), so no module cycle.
export type FindableBrowserPage = {
  browserPageId: string
  destroyed: boolean
  ready: Promise<unknown>
  element: Pick<HTMLDivElement, 'dispatchEvent'>
}

const pageFindStates = new Map<string, PageFindState>()
let findRequestCounter = 0

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readFindCount(envelope: unknown, key: string): number {
  if (!isRecord(envelope)) {
    return 0
  }
  const result = envelope.result
  if (!isRecord(result)) {
    return 0
  }
  const value = isRecord(result.value) ? result.value : null
  if (!value) {
    return 0
  }
  const count = value[key]
  return typeof count === 'number' && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
}

function dispatchFoundInPage(page: FindableBrowserPage, result: Record<string, unknown>): void {
  const event = new Event('found-in-page')
  for (const [key, value] of Object.entries(result)) {
    Object.defineProperty(event, key, { configurable: true, enumerable: true, value })
  }
  page.element.dispatchEvent(event)
}

// In-page find through CDP: the native find command only steps the
// selection forward, so match counting, direction, and the found-in-page
// event the find UI needs all live here. Counting replays window.find from
// the top inside one evaluate, so the counted matches use the same matching
// semantics as the visible selection.
export function runPageFind(
  page: FindableBrowserPage,
  text: string,
  options?: PageFindOptions
): number {
  if (!text || page.destroyed) {
    return 0
  }
  const forward = options?.forward !== false
  const matchCase = options?.matchCase === true
  const previous = pageFindStates.get(page.browserPageId)
  const fresh = options?.findNext !== false || !previous || previous.query !== text
  const mode = fresh ? (forward ? 'first' : 'last') : forward ? 'next' : 'previous'
  const anchor = previous && !fresh ? previous.ordinal : 0
  const requestId = (findRequestCounter += 1)
  const expression = `(() => { const q = ${JSON.stringify(text)};
  const mode = ${JSON.stringify(mode)};
  const anchor = ${JSON.stringify(anchor)};
  const caseSensitive = ${matchCase};
  const sel = window.getSelection();
  const out = { found: false, matches: 0, ordinal: 0 };
  if (!q || !sel || !document.body) return out;
  sel.collapse(document.body, 0);
  if (!window.find(q, caseSensitive, false, true)) { sel.removeAllRanges(); return out; }
  let matches = 1;
  const firstNode = sel.anchorNode;
  const firstOffset = sel.anchorOffset;
  while (matches < 5000) {
  if (!window.find(q, caseSensitive, false, true)) break;
  matches += 1;
  if (sel.anchorNode === firstNode && sel.anchorOffset === firstOffset) { matches -= 1; break; }
  }
  out.matches = matches;
  let target = 1;
  if (mode === 'last') target = matches;
  else if (mode === 'next') target = (anchor % matches) + 1;
  else if (mode === 'previous') target = ((anchor - 2 + matches) % matches) + 1;
  sel.collapse(document.body, 0);
  for (let i = 0; i < target; i += 1) { window.find(q, caseSensitive, false, true); }
  out.found = true;
  out.ordinal = target;
  return out;
  })()`
  void Promise.resolve(page.ready)
    .then(() =>
      invokeNative<unknown>('poc_browser_cdp', {
        args: {
          browserPageId: page.browserPageId,
          method: 'Runtime.evaluate',
          params: {
            expression,
            awaitPromise: false,
            returnByValue: true,
            userGesture: true
          }
        }
      })
    )
    .then((envelope) => {
      const matches = readFindCount(envelope, 'matches')
      const ordinal = readFindCount(envelope, 'ordinal')
      if (matches > 0) {
        pageFindStates.set(page.browserPageId, { query: text, matches, ordinal })
      } else {
        pageFindStates.delete(page.browserPageId)
      }
      dispatchFoundInPage(page, {
        result: { requestId, activeMatchOrdinal: ordinal, matches, finalUpdate: true }
      })
    })
    .catch(() => {})
  return requestId
}

export function stopPageFind(page: FindableBrowserPage, action?: string): void {
  pageFindStates.delete(page.browserPageId)
  if (action !== 'clearSelection' || page.destroyed) {
    return
  }
  void Promise.resolve(page.ready)
    .then(() =>
      invokeNative<unknown>('poc_browser_cdp', {
        args: {
          browserPageId: page.browserPageId,
          method: 'Runtime.evaluate',
          params: {
            expression: '(() => { window.getSelection()?.removeAllRanges(); return true; })()',
            awaitPromise: false,
            returnByValue: true
          }
        }
      })
    )
    .catch(() => {})
}
