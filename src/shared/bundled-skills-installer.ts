import { existsSync } from 'node:fs'
import { join, sep } from 'node:path'

export const BUNDLED_SKILLS_INSTALLER_FILENAME = 'cli.mjs'

export function resolveBundledSkillsInstaller(runtimeDirectory = __dirname): string {
  const directory = runtimeDirectory
    .split(sep)
    .map((part) => (part === 'app.asar' ? 'app.asar.unpacked' : part))
    .join(sep)
  const installer = join(
    directory,
    '..',
    'cli',
    'skills-installer',
    'dist',
    BUNDLED_SKILLS_INSTALLER_FILENAME
  )
  if (!existsSync(installer)) {
    throw new Error(
      'This Orca build is missing its locked skills installer. Run pnpm run build:skills-installer in a source checkout, or update Orca; no package will be downloaded.'
    )
  }
  return installer
}

const INSTALLER_ENV_KEYS = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'GROK_HOME',
  'HERMES_HOME',
  'VIBE_HOME',
  'AUTOHAND_HOME',
  'SARVAM_HOME',
  'FLATPAK_XDG_CONFIG_HOME',
  'KIRO_HOME',
  'PI_CODING_AGENT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID'
]

export function buildSkillsInstallerEnvironment(
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { LC_ALL: 'C', DISABLE_TELEMETRY: '1' }
  for (const [key, value] of Object.entries(base)) {
    if (
      INSTALLER_ENV_KEYS.some((allowed) =>
        process.platform === 'win32' ? key.toUpperCase() === allowed.toUpperCase() : key === allowed
      )
    ) {
      environment[key] = value
    }
  }
  return environment
}

export function assertSkillsInstallerNodeVersion(version = process.versions.node): void {
  const [major, minor] = version.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 20)) {
    throw new Error(
      `The locked skills installer requires Node.js 22.20.0 or newer; this host runs ${version}. Update Node.js on the machine installing the skills.`
    )
  }
}
