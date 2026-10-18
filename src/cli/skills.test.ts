import type * as BundledSkillsInstallerModule from '../shared/bundled-skills-installer'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const INSTALLER = '/bundled/skills-installer/dist/cli.mjs'
const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const PINNED_ADD = [INSTALLER, 'add', `https://github.com/stablyai/orca/tree/${COMMIT}`]
const DETECTED_AGENTS = ['--agent', 'claude-code', '--agent', 'universal']

const {
  detectCommandsMock,
  guideModuleLoadMock,
  readOrcaCliBuildCommitMock,
  runtimeClientConstructorMock,
  spawnMock
} = vi.hoisted(() => ({
  detectCommandsMock: vi.fn(() => new Set<string>(['claude'])),
  guideModuleLoadMock: vi.fn(),
  readOrcaCliBuildCommitMock: vi.fn<() => string | null>(() => null),
  runtimeClientConstructorMock: vi.fn(),
  spawnMock: vi.fn()
}))

// Why: agent detection probes the real machine, so pin it or every install
// assertion depends on what the test runner happens to have installed.
vi.mock('../shared/local-agent-install-dir-detection', () => ({
  detectCommandsInInstallDirs: detectCommandsMock
}))

vi.mock('../shared/bundled-skills-installer', async (importOriginal) => ({
  ...(await importOriginal<typeof BundledSkillsInstallerModule>()),
  resolveBundledSkillsInstaller: () => '/bundled/skills-installer/dist/cli.mjs'
}))

// Why: the install pins to the build's commit; a test run has no compiled package boundary.
vi.mock('./cli-version', () => ({
  readOrcaCliBuildCommit: readOrcaCliBuildCommitMock
}))

vi.mock('@orca/process-host', () => ({
  spawnProcess: ({ program, args, ...options }: { program: string; args: string[] }) =>
    spawnMock(program, args, options)
}))

vi.mock('./bundled-skill-guides.js', () => {
  guideModuleLoadMock()
  return {
    BUNDLED_SKILL_GUIDES: [
      {
        name: 'zeta',
        description: 'Use when zeta work\nspans lines.',
        markdown: '# Zeta\n',
        fullMarkdown: '# Zeta\n\n## References\n\nZeta reference.\n',
        aliases: []
      },
      {
        name: 'alpha',
        description: 'Use when alpha work is needed.',
        markdown: '# Alpha\n\nShort.\n',
        fullMarkdown: '# Alpha\n\nShort.\n\n## References\n\nFull.\n',
        aliases: ['legacy-alpha']
      },
      {
        name: 'gamma',
        description:
          'Use when gamma work spans several sentences describing exactly how a ' +
          'coding agent should decide whether gamma applies to the current task at hand.',
        markdown: '# Gamma\n',
        fullMarkdown: '# Gamma\n\n## References\n\nGamma reference.\n',
        aliases: []
      }
    ]
  }
})

vi.mock('./runtime-client', async () => {
  // Why: re-export the REAL error classes rather than redefining them. format.ts
  // narrows with `instanceof` against ./runtime/types, so a look-alike class
  // here would make every CLI error fall through to the generic `runtime_error`
  // shape — mirroring the barrel keeps the mock faithful to production.
  const { RuntimeClientError, RuntimeRpcFailureError } = await import('./runtime/types.js')

  class RuntimeClient {
    constructor() {
      runtimeClientConstructorMock()
    }
  }

  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError,
    serveOrcaApp: vi.fn(),
    getDefaultUserDataPath: vi.fn(() => '/tmp/orca-user-data')
  }
})

import { dispatch } from './dispatch'
import { main } from './index'

describe('orca skills CLI', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    runtimeClientConstructorMock.mockClear()
    detectCommandsMock.mockReset()
    detectCommandsMock.mockReturnValue(new Set<string>(['claude']))
    spawnMock.mockReset()
    readOrcaCliBuildCommitMock.mockReset()
    readOrcaCliBuildCommitMock.mockReturnValue(COMMIT)
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('keeps the bundled table off the eager command-registry path', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(guideModuleLoadMock).not.toHaveBeenCalled()
    await main(['status', '--help'], '/tmp/repo')
    expect(guideModuleLoadMock).not.toHaveBeenCalled()
  })

  it('dispatches an alias locally and emits the exact Markdown', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await dispatch(['skills', 'get'], {
      flags: new Map([['topic', 'legacy-alpha']]),
      get client(): never {
        throw new Error('skills get accessed RuntimeClient')
      },
      cwd: '/tmp/repo',
      json: false
    })

    expect(stdoutText(stdoutSpy)).toBe('# Alpha\n\nShort.\n')
  })

  it('lists canonical topics deterministically without constructing RuntimeClient', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'list'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe(
      'alpha: Use when alpha work is needed.\n' +
        'gamma: Use when gamma work spans several sentences describing exactly how a ' +
        'coding agent should decide whether gamma applies to the current task at hand.\n' +
        'zeta: Use when zeta work spans lines.\n'
    )
    expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
  })

  it('emits full Markdown for --full', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'get', 'alpha', '--full'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe('# Alpha\n\nShort.\n\n## References\n\nFull.\n')
  })

  it('supports the canonical single-item show verb as an alias', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'show', 'alpha'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe('# Alpha\n\nShort.\n')
  })

  it('gives list --json a stable canonical schema', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'list', '--json'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe(
      `${JSON.stringify(
        {
          topics: [
            { name: 'alpha', description: 'Use when alpha work is needed.' },
            {
              name: 'gamma',
              description:
                'Use when gamma work spans several sentences describing exactly how a ' +
                'coding agent should decide whether gamma applies to the current task at hand.'
            },
            { name: 'zeta', description: 'Use when zeta work spans lines.' }
          ]
        },
        null,
        2
      )}\n`
    )
  })

  it('gives alias get --json the canonical name, selection, and Markdown', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'get', 'legacy-alpha', '--full', '--json'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe(
      `${JSON.stringify(
        {
          name: 'alpha',
          full: true,
          markdown: '# Alpha\n\nShort.\n\n## References\n\nFull.\n'
        },
        null,
        2
      )}\n`
    )
  })

  it('shows leaf, group, and root help for skills', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['skills', 'get', '--help'], '/tmp/repo')
    await main(['skills', '--help'], '/tmp/repo')
    await main(['--help'], '/tmp/repo')

    expect(String(logSpy.mock.calls[0]?.[0])).toContain(
      'Usage: orca skills get <topic> [--full | --reference <name>] [--json]'
    )
    expect(String(logSpy.mock.calls[1]?.[0])).toContain(
      'Commands:\n  installed          List installed skill selectors'
    )
    expect(String(logSpy.mock.calls[1]?.[0])).toContain(
      'get                Print a version-matched skill guide'
    )
    expect(String(logSpy.mock.calls[1]?.[0])).toContain(
      'install            Install bundled Orca skills'
    )
    expect(String(logSpy.mock.calls[1]?.[0])).toContain(
      'update             Update Orca skills to the version this Orca build ships'
    )
    expect(String(logSpy.mock.calls[2]?.[0])).toContain('Skills:\n  skills installed')
    expect(String(logSpy.mock.calls[2]?.[0])).toContain('skills update')
    expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
  })

  it('returns a nonzero error with all canonical topics for an unknown topic', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'get', 'missing'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith(
      'Unknown skill topic "missing". Available topics: alpha, gamma, zeta'
    )
    expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
  })

  it('lists installable skills when no --skill/--all is given', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'install'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe(
      [
        'Choose one or more skills to install:',
        '  alpha',
        '  gamma',
        '  zeta',
        '',
        'Usage: orca skills install --skill <name> [--skill <name> ...]',
        '   or: orca skills install --all',
        ''
      ].join('\n')
    )
    expect(spawnMock).not.toHaveBeenCalled()
    expect(runtimeClientConstructorMock).not.toHaveBeenCalled()
  })

  it('gives install --json (no selection) a stable schema', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'install', '--json'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe(
      `${JSON.stringify({ availableSkills: ['alpha', 'gamma', 'zeta'] }, null, 2)}\n`
    )
  })

  it('rejects combining --all with --skill', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'install', '--all', '--skill', 'alpha'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith('Use either --all or --skill, not both.')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects an unknown --skill name', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'install', '--skill', 'missing'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith(
      'Unknown skill "missing". Available skills: alpha, gamma, zeta'
    )
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects --skill without a value', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'install', '--skill'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith('--skill requires a value; it was passed with none.')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects --json for a real (non-dry-run) install', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['skills', 'install', '--skill', 'alpha', '--json'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify(
        {
          id: 'local',
          ok: false,
          error: {
            code: 'invalid_argument',
            message:
              "orca skills install --json only supports --dry-run. Real installs stream the installer's " +
              "own output, which isn't JSON."
          },
          _meta: { runtimeId: null }
        },
        null,
        2
      )
    )
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('prints the resolved install command without running it for --dry-run', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'install', '--skill', 'alpha', '--dry-run'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe(
      `${process.execPath} ${INSTALLER} add https://github.com/stablyai/orca/tree/${COMMIT} --skill alpha --global --agent claude-code --agent universal -y\n\n` +
        'Rerun without --dry-run to install now.\n'
    )
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('gives dry-run --json a stable schema', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'install', '--skill', 'legacy-alpha', '--dry-run', '--json'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe(
      `${JSON.stringify(
        {
          command: `${process.execPath} ${INSTALLER} add https://github.com/stablyai/orca/tree/${COMMIT} --skill alpha --global --agent claude-code --agent universal -y`,
          skills: ['alpha'],
          global: true,
          executed: false
        },
        null,
        2
      )}\n`
    )
  })

  it('drops --global for --local in the dry-run command and JSON', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'install', '--skill', 'alpha', '--local', '--dry-run'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe(
      `${process.execPath} ${INSTALLER} add https://github.com/stablyai/orca/tree/${COMMIT} --skill alpha --agent claude-code --agent universal -y\n\n` +
        'Rerun without --dry-run to install now.\n'
    )

    stdoutSpy.mockClear()
    await main(
      ['skills', 'install', '--skill', 'alpha', '--local', '--dry-run', '--json'],
      '/tmp/repo'
    )

    expect(stdoutText(stdoutSpy)).toBe(
      `${JSON.stringify(
        {
          command: `${process.execPath} ${INSTALLER} add https://github.com/stablyai/orca/tree/${COMMIT} --skill alpha --agent claude-code --agent universal -y`,
          skills: ['alpha'],
          global: false,
          executed: false
        },
        null,
        2
      )}\n`
    )
  })

  it('keeps interactive selection in the upstream installer without unattended flags', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const operation = main(
      ['skills', 'install', '--skill', 'alpha', '--interactive', '--locked-installer'],
      '/tmp/repo'
    )
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([...PINNED_ADD, '--skill', 'alpha', '--global'])
    child.emit('exit', 0)
    await operation
  })

  it('honors the official build commit carried by a generated install command', async () => {
    const sourceCommit = 'a'.repeat(40)
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await main(
      ['skills', 'install', '--skill', 'alpha', '--source-commit', sourceCommit, '--dry-run'],
      '/tmp/repo'
    )
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining(`/tree/${sourceCommit}`))
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects an invalid source commit before starting an executable', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await main(['skills', 'install', '--skill', 'alpha', '--source-commit', 'latest'], '/tmp/repo')
    expect(process.exitCode).toBe(1)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('passes the execution host homes without application credentials or Node loaders', async () => {
    vi.stubEnv('HOME', '/home/guest')
    vi.stubEnv('OPENAI_API_KEY', 'private-key')
    vi.stubEnv('GH_TOKEN', 'private-token')
    vi.stubEnv('NODE_OPTIONS', '--require=/tmp/injected.js')
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const operation = main(
      ['skills', 'install', '--skill', 'alpha', '--agent', 'universal'],
      '/tmp/repo'
    )
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    const environment = spawnMock.mock.calls[0]?.[2]?.env
    expect(environment.HOME).toBe('/home/guest')
    expect(environment.OPENAI_API_KEY).toBeUndefined()
    expect(environment.GH_TOKEN).toBeUndefined()
    expect(environment.NODE_OPTIONS).toBeUndefined()
    child.emit('exit', 0)
    await operation
  })

  it('runs the bundled installer without --global for --local, with git messages forced to English', async () => {
    // A translated git error stops the skills CLI falling back to fetching the commit (#28914).
    vi.stubEnv('LC_ALL', 'de_DE.UTF-8')
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(['skills', 'install', '--skill', 'alpha', '--local'], '/tmp/repo')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 0, null)
    await resultPromise

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [...PINNED_ADD, '--skill', 'alpha', ...DETECTED_AGENTS, '-y'],
      expect.objectContaining({ stdio: 'inherit', env: expect.objectContaining({ LC_ALL: 'C' }) })
    )
  })

  it('resolves a legacy topic alias to the canonical skill name for install', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(['skills', 'install', '--skill', 'legacy-alpha'], '/tmp/repo')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 0, null)
    await resultPromise

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [...PINNED_ADD, '--skill', 'alpha', '--global', ...DETECTED_AGENTS, '-y'],
      expect.objectContaining({ stdio: 'inherit' })
    )
  })

  it('runs the bundled installer for --all and forwards its exit code', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(['skills', 'install', '--all'], '/tmp/repo')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 1, null)
    await resultPromise

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [
        ...PINNED_ADD,
        '--skill',
        'alpha',
        '--skill',
        'gamma',
        '--skill',
        'zeta',
        '--global',
        ...DETECTED_AGENTS,
        '-y'
      ],
      expect.objectContaining({ stdio: 'inherit' })
    )
    expect(process.exitCode).toBe(1)
  })

  it('propagates a spawn error as a nonzero exit', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(['skills', 'install', '--skill', 'alpha'], '/tmp/repo')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('error', new Error('spawn node ENOENT'))
    await resultPromise

    expect(process.exitCode).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith('spawn node ENOENT')
  })

  it('lists updatable skills when no --skill/--all is given', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'update'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe(
      [
        'Choose one or more skills to update:',
        '  alpha',
        '  gamma',
        '  zeta',
        '',
        'Usage: orca skills update --skill <name> [--skill <name> ...]',
        '   or: orca skills update --all',
        ''
      ].join('\n')
    )
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('prints the resolved update command without running it for --dry-run', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'update', '--skill', 'legacy-alpha', '--dry-run'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toBe(
      `${process.execPath} ${INSTALLER} add https://github.com/stablyai/orca/tree/${COMMIT} --skill alpha --global --agent claude-code --agent universal -y\n\n` +
        'Rerun without --dry-run to update now.\n'
    )
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('selects project scope for --local on update', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(
      ['skills', 'update', '--skill', 'alpha', '--local', '--dry-run', '--json'],
      '/tmp/repo'
    )

    expect(stdoutText(stdoutSpy)).toBe(
      `${JSON.stringify(
        {
          command: `${process.execPath} ${INSTALLER} add https://github.com/stablyai/orca/tree/${COMMIT} --skill alpha --agent claude-code --agent universal -y`,
          skills: ['alpha'],
          global: false,
          executed: false
        },
        null,
        2
      )}\n`
    )
  })

  it('runs local updates with explicit project scope', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(['skills', 'update', '--skill', 'alpha', '--local'], '/tmp/repo')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 0, null)
    await resultPromise

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [...PINNED_ADD, '--skill', 'alpha', ...DETECTED_AGENTS, '-y'],
      expect.objectContaining({ stdio: 'inherit' })
    )
  })

  it('refuses a real run when the shell forwards orca to the Orca host', async () => {
    vi.stubEnv('ORCA_CLI_CWD', '/home/alice/wt')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'install', '--skill', 'alpha'], '/tmp/repo')

    // Why: the SSH relay and WSL bridge run argv on the Orca host, so a real
    // install there would silently skip the machine the user is sitting on.
    expect(spawnMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('writes to the machine that runs it')
  })

  it('refuses --dry-run through the host-forwarding shim too', async () => {
    vi.stubEnv('ORCA_CLI_CWD', '/home/alice/wt')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'install', '--skill', 'alpha', '--dry-run'], '/tmp/repo')

    // Why: the targets are resolved from THIS host's agents, so a command printed
    // here would name the wrong machine's agents. Point at the target instead.
    expect(spawnMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('writes to the machine that runs it')
  })

  it('refuses to install when Orca detects no agent, instead of targeting them all', async () => {
    detectCommandsMock.mockReturnValue(new Set<string>())
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'install', '--skill', 'alpha'], '/tmp/repo')

    // Why: `skills add -y` with nothing detected installs into every agent it
    // knows (~75), creating config dirs for agents the host does not have.
    expect(spawnMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('No coding agent detected')
  })

  it('honours an explicit --agent list without probing the host', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    detectCommandsMock.mockReturnValue(new Set<string>())
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(
      ['skills', 'install', '--skill', 'alpha', '--agent', 'codex, claude-code ,codex'],
      '/tmp/repo'
    )
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 0, null)
    await resultPromise

    const argv = spawnMock.mock.calls[0]?.[1] ?? []
    const agents = argv.filter((_: string, i: number) => argv[i - 1] === '--agent')
    // Why: trimmed and de-duplicated, and detection is not consulted at all.
    expect(agents).toEqual(['codex', 'claude-code'])
    expect(detectCommandsMock).not.toHaveBeenCalled()
  })

  it('maps detected agents onto the skills CLI namespace, not Orca ids', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    detectCommandsMock.mockReturnValue(new Set<string>(['claude', 'cursor-agent', 'acli']))

    await main(['skills', 'install', '--skill', 'alpha', '--dry-run'], '/tmp/repo')

    // Why: `skills add` exits 1 on an unknown --agent, and the ids differ —
    // Orca's `claude` is `claude-code` and its `rovo` is `rovodev`.
    expect(stdoutText(stdoutSpy)).toContain(
      '--agent claude-code --agent cursor --agent rovodev --agent universal'
    )
  })

  it('updates with the same pinned add and agent targets as install', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'install', '--skill', 'alpha', '--dry-run', '--json'], '/tmp/repo')
    await main(['skills', 'update', '--skill', 'alpha', '--dry-run', '--json'], '/tmp/repo')

    const [install, update] = stdoutSpy.mock.calls.map((call) => JSON.parse(String(call[0])))
    // Why: `skills update` follows GitHub HEAD, which runs ahead of this release.
    expect(update.command).toBe(install.command)
    expect(update.command).toContain(`add https://github.com/stablyai/orca/tree/${COMMIT}`)
  })

  it('honours an explicit --agent list for an update', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(
      ['skills', 'update', '--skill', 'alpha', '--agent', 'universal', '--dry-run'],
      '/tmp/repo'
    )

    expect(stdoutText(stdoutSpy)).toContain(
      `${process.execPath} ${INSTALLER} add https://github.com/stablyai/orca/tree/${COMMIT} --skill alpha --global --agent universal -y`
    )
  })

  it('never refuses an update on a bare host; it targets the shared folder', async () => {
    detectCommandsMock.mockReturnValue(new Set<string>())
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(['skills', 'update', '--skill', 'alpha', '--dry-run'], '/tmp/repo')

    expect(stdoutText(stdoutSpy)).toContain(
      `${process.execPath} ${INSTALLER} add https://github.com/stablyai/orca/tree/${COMMIT} --skill alpha --global --agent universal -y`
    )
  })

  it('refuses to run when the CLI cannot read its own release version', async () => {
    readOrcaCliBuildCommitMock.mockReturnValue(null)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'update', '--skill', 'alpha', '--dry-run'], '/tmp/repo')

    expect(spawnMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('Could not read the commit')
  })

  it.each([
    ['a bare --agent', ['skills', 'install', '--skill', 'alpha', '--agent']],
    ['an empty --agent', ['skills', 'install', '--skill', 'alpha', '--agent', '']],
    ['a separator-only --agent', ['skills', 'install', '--skill', 'alpha', '--agent', ' , ,']]
  ])('rejects %s instead of installing to every agent', async (_label, argv) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(argv, '/tmp/repo')

    // Why: an --agent that resolves to nothing must not fall back to detection or
    // emit no --agent at all — the latter restores the ~75-agent install.
    expect(spawnMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('Missing required --agent')
  })

  it.each([
    ['a dash-leading value', ['skills', 'install', '--skill', 'alpha', '--agent', '-y']],
    ['an inline dash value', ['skills', 'install', '--skill', 'alpha', '--agent=--copy']],
    ['a value with a space', ['skills', 'install', '--skill', 'alpha', '--agent', 'a b']]
  ])('rejects %s the skills CLI would silently drop', async (_label, argv) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(argv, '/tmp/repo')

    // Why: the skills CLI drops such a value, leaving it with no target — the same
    // all-agents install as omitting --agent entirely.
    expect(spawnMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('Invalid --agent value')
  })

  it('reports forwarding, not missing agents, when a forwarded host detects none', async () => {
    vi.stubEnv('ORCA_CLI_CWD', '/home/alice/wt')
    detectCommandsMock.mockReturnValue(new Set<string>())
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['skills', 'install', '--skill', 'alpha'], '/tmp/repo')

    // Why: resolving targets first would hide the forwarding problem behind a
    // no-agent error about the wrong machine.
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('writes to the machine that runs it')
  })

  it('documents --agent for skills install rather than the terminal-launch flag', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['skills', 'install', '--help'], '/tmp/repo')

    const help = String(logSpy.mock.calls[0]?.[0])
    expect(help).toContain('--agent <names>')
    expect(help).not.toContain('Launch a known TUI agent')
  })

  it('accumulates a repeated --skill instead of keeping only the last one', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(
      ['skills', 'install', '--skill', 'zeta', '--skill', 'alpha'],
      '/tmp/repo'
    )
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 0, null)
    await resultPromise

    // Why: the documented primary invocation. Dropping 'skill' from the
    // repeatable-flag set silently installs one skill instead of two.
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [...PINNED_ADD, '--skill', 'alpha', '--skill', 'zeta', '--global', ...DETECTED_AGENTS, '-y'],
      expect.objectContaining({ stdio: 'inherit' })
    )
  })

  it('collapses an alias and its canonical name into one --skill', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await main(
      ['skills', 'install', '--skill', 'alpha', '--skill', 'legacy-alpha', '--dry-run'],
      '/tmp/repo'
    )

    expect(stdoutText(stdoutSpy)).toBe(
      `${process.execPath} ${INSTALLER} add https://github.com/stablyai/orca/tree/${COMMIT} --skill alpha --global --agent claude-code --agent universal -y\n\n` +
        'Rerun without --dry-run to install now.\n'
    )
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('reports the command it is about to run on stderr', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(['skills', 'install', '--skill', 'alpha'], '/tmp/repo')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 0, null)
    await resultPromise

    // Why: stdout belongs to the child, so this record has to go to stderr.
    expect(stderrSpy).toHaveBeenCalledWith(
      `Running: ${process.execPath} ${INSTALLER} add https://github.com/stablyai/orca/tree/${COMMIT} --skill alpha --global --agent claude-code --agent universal -y\n`
    )
  })

  it('runs the pinned add for update --all and forwards its exit code', async () => {
    const child = createFakeChild()
    spawnMock.mockReturnValue(child)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const resultPromise = main(['skills', 'update', '--all'], '/tmp/repo')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 2, null)
    await resultPromise

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [
        ...PINNED_ADD,
        '--skill',
        'alpha',
        '--skill',
        'gamma',
        '--skill',
        'zeta',
        '--global',
        ...DETECTED_AGENTS,
        '-y'
      ],
      expect.objectContaining({ stdio: 'inherit' })
    )
    expect(process.exitCode).toBe(2)
  })

  it('rejects --json for a real (non-dry-run) update', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['skills', 'update', '--skill', 'alpha', '--json'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify(
        {
          id: 'local',
          ok: false,
          error: {
            code: 'invalid_argument',
            message:
              "orca skills update --json only supports --dry-run. Real updates stream the installer's " +
              "own output, which isn't JSON."
          },
          _meta: { runtimeId: null }
        },
        null,
        2
      )
    )
    expect(spawnMock).not.toHaveBeenCalled()
  })
})

function stdoutText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call) => String(call[0])).join('')
}

function createFakeChild(): EventEmitter {
  return new EventEmitter()
}
