import type { PreloadApi } from '../../../preload/api-types'
import type { MemorySnapshot, StatsSummary } from '../../../shared/process-stats-types'
import { createWebE2EApi } from './preload-api/web-e2e-api'
import { createWebFolderWorkspacesApi } from './preload-api/web-folder-workspaces-api'
import {
  createClaudeAccountsApi,
  createCodexAccountsApi,
  createCursorAccountsApi,
  createGrokAccountsApi,
  createZcodePlanCredentialsApi,
  createOpenCodeGoCredentialsApi,
  createMiniMaxCredentialsApi
} from './preload-api/web-agent-accounts-api'
import { createWebAgentStatusApi } from './preload-api/web-agent-status-api'
import { createLegacyRelayBridgeApi } from './preload-api/web-legacy-relay-bridge-api'
import { createWebAiVaultApi } from './preload-api/web-ai-vault-api'
import { createWebAppApi } from './preload-api/web-app-api'
import { createBrowserApi, createEmulatorApi } from './preload-api/web-browser-api'
import { createCliApi } from './preload-api/web-cli-api'
import { createWebDiagnosticsApi } from './preload-api/web-diagnostics-api'
import { withFallback } from './preload-api/web-fallback-api'
import { createFileApi } from './preload-api/web-filesystem-api'
import { createGitApi } from './preload-api/web-git-api'
import { createWebGithubCacheApi } from './preload-api/web-github-cache-api'
import { createGitHubApi } from './preload-api/web-github-api'
import { createGitLabApi } from './preload-api/web-gitlab-api'
import {
  createComputerUsePermissionsApi,
  createDeveloperPermissionsApi,
  createPreflightApi,
  createSkillsApi
} from './preload-api/web-host-capability-api'
import { createWebKeybindingsApi } from './preload-api/web-keybindings-api'
import { createTauriNativeKeybindingsApi } from './tauri-native-keybindings-api'
import { createMacosTccPromptsApi } from './preload-api/web-macos-tcc-api'
import { createEmptyMemorySnapshot } from './preload-api/web-memory-api'
import { createWebMobileApi } from './preload-api/web-mobile-api'
import { createWebNativeChatApi } from './preload-api/web-native-chat-api'
import { createNotificationsApi } from './preload-api/web-notifications-api'
import { createWebOnboardingApi } from './preload-api/web-onboarding-api'
import { createWebOrcaProfilesApi } from './preload-api/web-orca-profiles-api'
import { createWebPlatformApi } from './preload-api/web-platform-api'
import { createWebPluginsApi } from './preload-api/web-plugins-api'
import { createWebProjectGroupsApi } from './preload-api/web-project-groups-api'
import { createWebProjectsApi } from './preload-api/web-projects-api'
import { createRateLimitsApi } from './preload-api/web-rate-limits-api'
import { createReposApi } from './preload-api/web-repositories-api'
import { createHooksApi, createRuntimeNamespaceApi } from './preload-api/web-review-api'
import { createWebJiraApi } from './preload-api/web-jira-api'
import { callRuntimeResult } from './preload-api/web-runtime-calls'
import { createWebRuntimeApi } from './preload-api/web-runtime-api'
import { createRuntimeEnvironmentsApi } from './preload-api/web-runtime-environments-api'
import { webRuntimeState } from './preload-api/web-runtime-session'
import { createWebSettingsApi } from './preload-api/web-settings-api'
import { createTauriNativeSettingsApi } from './tauri-native-settings-api'
import { invokeNative } from './tauri-native-host'
import { createWebSpeechApi } from './preload-api/web-speech-api'
import { createShellApi } from './preload-api/web-shell-api'
import { createWebStarNagApi } from './preload-api/web-star-nag-api'
import { createWebTelemetryApi } from './preload-api/web-telemetry-api'
import {
  createClaudeUsageApi,
  createCodexUsageApi,
  createMuseUsageApi,
  createOpenCodeUsageApi
} from './preload-api/web-usage-api'
import { createPtyApi, createSshApi } from './preload-api/web-terminal-api'
import { createWebUiApi } from './preload-api/web-ui-api'
import { createUpdaterApi } from './preload-api/web-updater-api'
import { createWebWorkspacePortsApi } from './preload-api/web-workspace-ports-api'
import { createWebWorkspaceSessionApi } from './preload-api/web-workspace-session-api'
import { createWebSparsePresetsApi } from './preload-api/web-sparse-presets-api'
import {
  createWebAutomationsApi,
  createWebDocPreviewApi,
  createWebWorkspaceSpaceApi
} from './preload-api/web-desktop-compat-api'
import { createWorktreesApi } from './preload-api/web-worktrees-api'
import {
  createTauriNativeAppNamespaceApi,
  createTauriNativeBrowserApi,
  createTauriNativeFilesystemDropApi,
  createTauriNativeFilesystemApi,
  createTauriNativeNotificationsApi,
  createTauriNativePreloadApi,
  createTauriNativePlatformNamespaceApi,
  createTauriNativeUiApi,
  installTauriBrowserGuestCtrlTabCommit,
  installTauriBrowserGuestShortcutForwarding,
  installTauriWindowDragBridge,
  isTauriNativeHost
} from './tauri-native-bridge'
import { readStoredWebRuntimeEnvironment } from './web-runtime-environment'
import { createTauriNativeLocalLogTailApi } from './tauri-native-local-log-tail-api'
import { installTauriSystemTray } from './tauri-native-tray-api'

export function installWebPreloadApi(): void {
  webRuntimeState.activeEnvironment = readStoredWebRuntimeEnvironment()
  const webWindow = window as unknown as { __ORCA_WEB_CLIENT__?: boolean }
  webWindow.__ORCA_WEB_CLIENT__ = true
  installTauriWindowDragBridge()
  installTauriBrowserGuestShortcutForwarding()
  installTauriBrowserGuestCtrlTabCommit()
  installTauriSystemTray()
  const api = createWebPreloadApi()
  if (isTauriNativeHost()) {
    const nativeApi = createTauriNativePreloadApi()
    if (nativeApi.shell) {
      api.shell = nativeApi.shell
    }
    Object.assign(api, nativeApi)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: withFallback preserves the PreloadApi shape while filling omitted optional namespaces at runtime.
  window.api = withFallback(api, []) as PreloadApi
}

type TauriShellAvailability = {
  gitBash: boolean
  pwsh: boolean
  wslAvailable: boolean
  wslDistros: string[]
  hostPlatform: string
}

// Local shell probes are host-owned; on the Tauri shell Rust answers them
// directly, so a local run does not wait on (or require) a paired runtime.
let tauriShellAvailabilityPromise: Promise<TauriShellAvailability | null> | undefined
function tauriShellAvailability(): Promise<TauriShellAvailability | null> {
  if (!isTauriNativeHost()) {
    return Promise.resolve(null)
  }
  tauriShellAvailabilityPromise ??= invokeNative<TauriShellAvailability>(
    'poc_shell_availability'
  ).catch(() => null)
  return tauriShellAvailabilityPromise
}

function createWebPreloadApi(): Partial<PreloadApi> {
  const fileApi = createFileApi()
  const webSettingsApi = createWebSettingsApi()
  const nativeSettingsApi = createTauriNativeSettingsApi()
  return {
    ...createWebAppApi(),
    ...createWebStarNagApi(),
    ...createWebPlatformApi(),
    ...createWebWorkspacePortsApi(),
    workspaceSpace: createWebWorkspaceSpaceApi(),
    ...createWebOrcaProfilesApi(),
    ...createWebE2EApi(),
    ...createTauriNativePlatformNamespaceApi(),
    ...createTauriNativeAppNamespaceApi(),
    ...webSettingsApi,
    ...(webSettingsApi.settings
      ? { settings: { ...webSettingsApi.settings, ...nativeSettingsApi } }
      : {}),
    keybindings: createTauriNativeKeybindingsApi() ?? createWebKeybindingsApi(),
    ui: {
      ...createWebUiApi(),
      ...createTauriNativeUiApi()
    },
    ...createWebDiagnosticsApi(),
    ...createWebWorkspaceSessionApi(),
    ...createWebOnboardingApi(),
    ...createWebGithubCacheApi(),
    runtime: createWebRuntimeApi(),
    nativeChat: createWebNativeChatApi(),
    docPreview: createWebDocPreviewApi(),
    runtimeEnvironments: createRuntimeEnvironmentsApi(),
    repos: createReposApi(),
    projects: createWebProjectsApi(),
    projectGroups: createWebProjectGroupsApi(),
    sparsePresets: createWebSparsePresetsApi(),
    folderWorkspaces: createWebFolderWorkspacesApi(),
    worktrees: createWorktreesApi(),
    fs: {
      ...fileApi,
      ...createTauriNativeFilesystemDropApi(),
      ...createTauriNativeFilesystemApi(),
      ...createTauriNativeLocalLogTailApi(fileApi.readFile)
    },
    git: createGitApi(),
    browser: {
      ...createBrowserApi(),
      ...(isTauriNativeHost() ? createTauriNativeBrowserApi() : {})
    },
    emulator: createEmulatorApi(),
    gh: createGitHubApi(),
    gl: createGitLabApi(),
    hostedReview: createRuntimeNamespaceApi('hostedReview'),
    linear: createRuntimeNamespaceApi('linear'),
    jira: createWebJiraApi(),
    hooks: createHooksApi(),
    stats: {
      getSummary: async () =>
        callRuntimeResult<StatsSummary>('stats.summary').catch(() => ({
          totalAgentsSpawned: 0,
          totalPRsCreated: 0,
          totalAgentTimeMs: 0,
          firstEventAt: null
        }))
    },
    memory: {
      getSnapshot: () =>
        isTauriNativeHost()
          ? invokeNative<MemorySnapshot>('poc_memory_snapshot')
          : Promise.resolve(createEmptyMemorySnapshot())
    },
    aiVault: createWebAiVaultApi(),
    preflight: createPreflightApi(),
    notifications: {
      ...createNotificationsApi(),
      ...createTauriNativeNotificationsApi()
    },
    rateLimits: createRateLimitsApi(),
    claudeUsage: createClaudeUsageApi(),
    codexUsage: createCodexUsageApi(),
    openCodeUsage: createOpenCodeUsageApi(),
    museUsage: createMuseUsageApi(),
    opencodeGoCredentials: createOpenCodeGoCredentialsApi(),
    minimaxCredentials: createMiniMaxCredentialsApi(),
    zcodePlanCredentials: createZcodePlanCredentialsApi(),
    grokAccounts: createGrokAccountsApi(),
    cursorAccounts: createCursorAccountsApi(),
    codexAccounts: createCodexAccountsApi(),
    claudeAccounts: createClaudeAccountsApi(),
    cli: createCliApi(),
    macosTccPrompts: createMacosTccPromptsApi(),
    codexConfigSync: {
      status: () =>
        Promise.resolve({ state: 'synced', reason: null, systemConfigPath: '' } as const)
    },
    developerPermissions: createDeveloperPermissionsApi(),
    computerUsePermissions: createComputerUsePermissionsApi(),
    updater: createUpdaterApi(),
    speech: createWebSpeechApi(),
    shell: createShellApi(),
    skills: createSkillsApi(),
    plugins: createWebPluginsApi(),
    automations: createWebAutomationsApi(),
    pty: createPtyApi(),
    ssh: createSshApi(),
    legacyRelayBridge: createLegacyRelayBridgeApi(),
    wsl: {
      isAvailable: () =>
        tauriShellAvailability().then(
          (native) =>
            native?.wslAvailable ??
            callRuntimeResult<boolean>('host.wsl.isAvailable').catch(() => false)
        ),
      listDistros: () =>
        tauriShellAvailability().then(
          (native) =>
            native?.wslDistros ??
            callRuntimeResult<string[]>('host.wsl.listDistros').catch(() => [])
        )
    },
    // Desktop-only: a web client never owns a WSL move's desktop stores.
    wslMove: {
      listPendingRendererRewrites: () => Promise.resolve([]),
      recordStoreRewritten: () => Promise.resolve({ recorded: false, reason: 'gated-off' })
    },
    pwsh: {
      isAvailable: () =>
        tauriShellAvailability().then(
          (native) =>
            native?.pwsh ?? callRuntimeResult<boolean>('host.pwsh.isAvailable').catch(() => false)
        )
    },
    gitBash: {
      isAvailable: () =>
        tauriShellAvailability().then(
          (native) =>
            native?.gitBash ??
            callRuntimeResult<boolean>('host.gitBash.isAvailable').catch(() => false)
        )
    },
    ...createWebAgentStatusApi(),
    ...createWebMobileApi(),
    ...createWebTelemetryApi()
  }
}
