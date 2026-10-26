import { translate } from '@/i18n/i18n'
import type { PreloadApi } from '../../../../preload/api-types'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../shared/managed-account-types'
import type { CursorAccountStatus, GrokAccountStatus } from '../../../../shared/rate-limit-types'
import type { MiniMaxCredentialsStatus } from '../../../../shared/minimax-credential-types'
import type { ZcodePlanCredentialsStatus } from '../../../../shared/zcode-plan-sites'
import { callRuntimeResult } from './web-runtime-calls'
import { fetchAccountsSnapshot } from './web-rate-limits-api'
import { isTauriNativeHost } from '../tauri-native-host'

export function createMiniMaxCredentialsApi(): NonNullable<
  Partial<PreloadApi>['minimaxCredentials']
> {
  const nativeDesktop = isTauriNativeHost()
  // Nulls, not 'sealed': MiniMax credentials live on the desktop host, so this bridge
  // stores nothing and has no protection to claim either way.
  const notConfigured = {
    configured: false,
    cookieConfigured: false,
    apiKeyConfigured: false,
    cookieProtection: null,
    apiKeyProtection: null
  }
  const unsupportedError = new Error('MiniMax cookie storage is only available in the desktop app.')
  return {
    getStatus: () =>
      nativeDesktop
        ? callRuntimeResult<MiniMaxCredentialsStatus>('credentials.getMiniMaxStatus')
        : Promise.resolve(notConfigured),
    saveCookie: nativeDesktop
      ? (cookie) =>
          callRuntimeResult<MiniMaxCredentialsStatus>('credentials.saveMiniMaxCookie', {
            value: cookie
          })
      : () => Promise.reject(unsupportedError),
    clearCookie: nativeDesktop
      ? () => callRuntimeResult<MiniMaxCredentialsStatus>('credentials.clearMiniMaxCookie')
      : () => Promise.resolve(notConfigured),
    saveApiKey: nativeDesktop
      ? (key) =>
          callRuntimeResult<MiniMaxCredentialsStatus>('credentials.saveMiniMaxApiKey', {
            value: key
          })
      : () => Promise.reject(unsupportedError),
    clearApiKey: nativeDesktop
      ? () => callRuntimeResult<MiniMaxCredentialsStatus>('credentials.clearMiniMaxApiKey')
      : () => Promise.resolve(notConfigured)
  }
}

export function createZcodePlanCredentialsApi(): PreloadApi['zcodePlanCredentials'] {
  const nativeDesktop = isTauriNativeHost()
  const status = {
    detailsUnavailable: true,
    apiKeyConfigured: false,
    zcodeCliConfigured: false,
    apiKeyProtection: null
  }
  const unsupported = () =>
    Promise.reject(
      new Error(
        'GLM Coding Plan keys can only be changed in the desktop app on the computer running Orca.'
      )
    )
  return {
    getStatus: () =>
      nativeDesktop
        ? callRuntimeResult<ZcodePlanCredentialsStatus>('credentials.getZcodePlanStatus')
        : Promise.resolve(status),
    saveApiKey: nativeDesktop
      ? (key) =>
          callRuntimeResult<ZcodePlanCredentialsStatus>('credentials.saveZcodePlanApiKey', {
            value: key
          })
      : unsupported,
    clearApiKey: nativeDesktop
      ? () => callRuntimeResult<ZcodePlanCredentialsStatus>('credentials.clearZcodePlanApiKey')
      : unsupported
  }
}

export function createCursorAccountsApi(): NonNullable<Partial<PreloadApi>['cursorAccounts']> {
  const nativeDesktop = isTauriNativeHost()
  // Why an explanation and not a bare `signedIn: false`: Cursor's session lives on
  // the machine running Orca, and this bridge cannot read it. The host may well be
  // signed in — its usage meter still arrives over the rate-limit snapshot — so
  // asserting "not signed in" here would contradict the meter beside it.
  return {
    getStatus: () =>
      nativeDesktop
        ? callRuntimeResult<CursorAccountStatus>('credentials.getCursorStatus')
        : Promise.resolve({
            signedIn: false,
            email: null,
            displayName: null,
            credentialSource: null,
            planType: null,
            tokenFresh: false,
            error: translate(
              'auto.components.web.preloadApi.cursorAccounts.hostOnly',
              'Cursor sign-in details are only readable on the computer running Orca.'
            )
          })
  }
}

export function createOpenCodeGoCredentialsApi(): PreloadApi['opencodeGoCredentials'] {
  const nativeDesktop = isTauriNativeHost()
  const notConfigured = { apiKeyConfigured: false }
  return {
    getStatus: () =>
      nativeDesktop
        ? callRuntimeResult<{ apiKeyConfigured: boolean }>('credentials.getOpenCodeGoStatus')
        : Promise.resolve(notConfigured),
    saveApiKey: nativeDesktop
      ? (key) =>
          callRuntimeResult<{ apiKeyConfigured: boolean }>('credentials.saveOpenCodeGoApiKey', {
            value: key
          })
      : () =>
          Promise.reject(
            new Error('OpenCode Go key storage is only available in the desktop app.')
          ),
    clearApiKey: nativeDesktop
      ? () => callRuntimeResult<{ apiKeyConfigured: boolean }>('credentials.clearOpenCodeGoApiKey')
      : () => Promise.resolve(notConfigured)
  }
}

export function createGrokAccountsApi(): NonNullable<Partial<PreloadApi>['grokAccounts']> {
  const nativeDesktop = isTauriNativeHost()
  const unsigned = {
    signedIn: false,
    email: null,
    teamId: null,
    tokenFresh: false,
    error: null
  }
  return {
    getStatus: () =>
      nativeDesktop
        ? callRuntimeResult<GrokAccountStatus>('credentials.getGrokStatus')
        : Promise.resolve(unsigned)
  }
}

// Why: select/remove await provider usage refreshes on the server; give an applied switch room.
const ACCOUNT_MUTATION_TIMEOUT_MS = 30_000
const ACCOUNT_LOGIN_TIMEOUT_MS = 5 * 60_000
const ACCOUNT_PENDING_LOGIN_POLL_TIMEOUT_MS = 5_000

function rejectHostOnlySignIn(): Promise<never> {
  return Promise.reject(
    new Error(
      translate(
        'auto.components.web.preloadApi.accounts.signInHostOnly',
        'Adding or re-signing an account is only available in the desktop app on the computer running Orca.'
      )
    )
  )
}

// Why: the paired server owns Claude and Codex accounts; Tauri can also control its local
// services through the explicit native-desktop capability, while ordinary web clients stay read-only.
export function createClaudeAccountsApi(): PreloadApi['claudeAccounts'] {
  const nativeDesktop = isTauriNativeHost()
  return {
    list: async () => (await fetchAccountsSnapshot(false)).claude,
    add: nativeDesktop
      ? (args) =>
          callRuntimeResult<ClaudeRateLimitAccountsState>(
            'accounts.addClaude',
            args,
            ACCOUNT_LOGIN_TIMEOUT_MS
          )
      : rejectHostOnlySignIn,
    cancelPendingLogin: nativeDesktop
      ? () => callRuntimeResult<boolean>('accounts.cancelClaudePendingLogin')
      : () => Promise.resolve(false),
    reauthenticate: nativeDesktop
      ? (args) =>
          callRuntimeResult<ClaudeRateLimitAccountsState>(
            'accounts.reauthenticateClaude',
            args,
            ACCOUNT_LOGIN_TIMEOUT_MS
          )
      : rejectHostOnlySignIn,
    waitForSignInLink: nativeDesktop
      ? () => callRuntimeResult<string | null>('accounts.waitForClaudeSignInLink')
      : () => Promise.resolve(null),
    remove: ({ accountId }) =>
      callRuntimeResult<ClaudeRateLimitAccountsState>(
        'accounts.removeClaude',
        { accountId },
        ACCOUNT_MUTATION_TIMEOUT_MS
      ),
    select: ({ accountId, runtime }) => {
      // No targeted Claude select RPC; null would clear host lane, while concrete account IDs identify their lane.
      if (runtime === 'wsl' && accountId === null) {
        return Promise.reject(
          new Error(
            translate(
              'auto.components.web.preloadApi.accounts.claudeWslDefaultUnavailable',
              'Switching a WSL lane back to the system default is only available in the desktop app.'
            )
          )
        )
      }
      return callRuntimeResult<ClaudeRateLimitAccountsState>(
        'accounts.selectClaude',
        { accountId },
        ACCOUNT_MUTATION_TIMEOUT_MS
      )
    }
  }
}

export function createCodexAccountsApi(): PreloadApi['codexAccounts'] {
  const nativeDesktop = isTauriNativeHost()
  return {
    list: async () => (await fetchAccountsSnapshot(false)).codex,
    add: nativeDesktop
      ? (args) =>
          callRuntimeResult<CodexRateLimitAccountsState>(
            'accounts.addCodex',
            args,
            ACCOUNT_LOGIN_TIMEOUT_MS
          )
      : rejectHostOnlySignIn,
    cancelPendingLogin: nativeDesktop
      ? () => callRuntimeResult<boolean>('accounts.cancelCodexPendingLogin')
      : () => Promise.resolve(false),
    // Why: ordinary web clients have no link to offer; Tauri polls the local runtime while Settings
    // is mounted because the login service's native event is not a renderer event.
    getPendingLoginUrl: nativeDesktop
      ? () => callRuntimeResult<string | null>('accounts.getCodexPendingLoginUrl')
      : () => Promise.resolve(null),
    onPendingLoginUrlChanged: nativeDesktop
      ? (callback) => {
          let active = true
          let polling = false
          let last: string | null | undefined
          const poll = (): void => {
            if (polling) {
              return
            }
            polling = true
            void callRuntimeResult<string | null>(
              'accounts.getCodexPendingLoginUrl',
              undefined,
              ACCOUNT_PENDING_LOGIN_POLL_TIMEOUT_MS
            )
              .then((url) => {
                if (active && url !== last) {
                  last = url
                  callback(url)
                }
              })
              .catch(() => {})
              .finally(() => {
                polling = false
              })
          }
          poll()
          const timer = setInterval(poll, 750)
          return () => {
            active = false
            clearInterval(timer)
          }
        }
      : () => () => {},
    reauthenticate: nativeDesktop
      ? (args) =>
          callRuntimeResult<CodexRateLimitAccountsState>(
            'accounts.reauthenticateCodex',
            args,
            ACCOUNT_LOGIN_TIMEOUT_MS
          )
      : rejectHostOnlySignIn,
    remove: ({ accountId }) =>
      callRuntimeResult<CodexRateLimitAccountsState>(
        'accounts.removeCodex',
        { accountId },
        ACCOUNT_MUTATION_TIMEOUT_MS
      ),
    // Why: a WSL lane needs the targeted RPC, or a null selection would clear the host lane.
    select: ({ accountId, runtime, wslDistro }) =>
      runtime === 'wsl'
        ? callRuntimeResult<CodexRateLimitAccountsState>(
            'accounts.selectCodexForTarget',
            { accountId, target: { runtime: 'wsl', wslDistro: wslDistro ?? null } },
            ACCOUNT_MUTATION_TIMEOUT_MS
          )
        : callRuntimeResult<CodexRateLimitAccountsState>(
            'accounts.selectCodex',
            { accountId },
            ACCOUNT_MUTATION_TIMEOUT_MS
          ),
    // PTY host owns launch-account records; return no stale panes instead of rejecting the sweep.
    listStalePanes: () => Promise.resolve([]),
    // No web-owned lane records; empty results let every pane use derivation.
    listRecordedPaneLanes: () => Promise.resolve({}),
    forgetStalePanes: () => Promise.resolve()
  }
}
