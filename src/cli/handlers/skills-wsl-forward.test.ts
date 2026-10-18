import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as wslShell from '../../shared/wsl-login-shell-command'
import { buildPosixStdoutFence } from '../../shared/posix-stdout-fence'
import { forwardSkillsToWsl } from './skills-wsl-forward'

const { spawn, run } = vi.hoisted(() => ({ spawn: vi.fn(), run: vi.fn() }))
vi.mock('@orca/process-host', () => ({ spawnProcess: spawn, runProcess: run }))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  spawn.mockReset()
  run.mockReset()
})

describe('locked skills WSL forwarding', () => {
  it('runs on the named guest with safe argv and guest-side agent detection', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.stubEnv('ORCA_CLI_WSL_DISTRO', 'Ubuntu Work')
    vi.stubEnv('WSLENV', 'HOME/p:CODEX_API_KEY')
    vi.stubEnv('CODEX_API_KEY', 'host-secret')
    const child = new EventEmitter()
    spawn.mockReturnValue(child)
    const previousExitCode = process.exitCode
    try {
      const operation = forwardSkillsToWsl(
        ['skills', 'install', '--skill', 'orca-cli', '--interactive', '--locked-installer'],
        "C:\\Work\\Ada's $project"
      )
      const spec = spawn.mock.calls[0]?.[0]
      expect(spec.env).not.toHaveProperty('WSLENV')
      expect(spec.env).not.toHaveProperty('ORCA_CLI_CWD')
      expect(spec.env).not.toHaveProperty('CODEX_API_KEY')
      expect(spec.program).toBe('wsl.exe')
      expect(spec.args.slice(0, 4)).toEqual(['-d', 'Ubuntu Work', '--exec', '/bin/sh'])
      expect(spec.args.at(-1)).toContain('wslpath -u')
      expect(spec.args.at(-1)).toContain(
        'unset ORCA_CLI_CWD ORCA_CLI_WSL_DISTRO NODE_OPTIONS NODE_PATH ELECTRON_RUN_AS_NODE'
      )
      expect(spec.args.at(-1)).toContain('exec node')
      expect(spec.args.at(-1)).not.toContain('npx')
      child.emit('exit', 17)
      expect(await operation).toBe(true)
      expect(process.exitCode).toBe(17)
    } finally {
      process.exitCode = previousExitCode
    }
  })

  it('uses UNC ownership without requiring the launcher distro environment', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.stubEnv('ORCA_CLI_WSL_DISTRO', '')
    const child = new EventEmitter()
    spawn.mockReturnValue(child)
    const previousExitCode = process.exitCode
    try {
      const operation = forwardSkillsToWsl(
        ['skills', 'install', '--local'],
        String.raw`\\wsl.localhost\Ubuntu\home\ada\project`
      )
      const spec = spawn.mock.calls[0]?.[0]
      expect(spec.args.slice(0, 3)).toEqual(['-d', 'Ubuntu', '--exec'])
      expect(spec.args.at(-1)).toContain('/home/ada/project')
      expect(spec.args.at(-1)).not.toContain('wslpath -u \\wsl')
      child.emit('exit', 0)
      expect(await operation).toBe(true)
    } finally {
      process.exitCode = previousExitCode
    }
  })

  it('removes login banners from JSON while preserving guest output and exit status', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.stubEnv('ORCA_CLI_WSL_DISTRO', 'Ubuntu')
    vi.spyOn(wslShell, 'buildWslCapturedLoginShellCommand').mockImplementation((command) =>
      buildPosixStdoutFence(command, 'WSL', 'test')
    )
    run.mockResolvedValue({
      stdout:
        'Ubuntu banner\n__ORCA_WSL_CAPTURE_BEGIN_test__{"executed":false}\n__ORCA_WSL_CAPTURE_END_test__logout\n',
      stderr: '',
      code: 0
    })
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const previousExitCode = process.exitCode
    try {
      expect(
        await forwardSkillsToWsl(['skills', 'install', '--dry-run', '--json'], 'C:\\Work')
      ).toBe(true)
      expect(stdout).toHaveBeenCalledWith('{"executed":false}\n')
      expect(spawn).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(0)
    } finally {
      process.exitCode = previousExitCode
    }
  })

  it('does not forward an ordinary local or SSH host invocation', async () => {
    vi.stubEnv('ORCA_CLI_WSL_DISTRO', '')
    expect(await forwardSkillsToWsl(['skills', 'install'], '/home/ada/project')).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })
})
