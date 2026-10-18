import { getWslAccountTarget } from './account-wsl-location'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { spawnProcess, runProcess } from '@orca/process-host'
import { buildSkillsInstallerEnvironment } from '../../shared/bundled-skills-installer'
import {
  buildWslExecArgs,
  buildWslLoginShellCommand,
  buildWslCapturedLoginShellCommand,
  quotePosixShell
} from '../../shared/wsl-login-shell-command'
import { RuntimeClientError } from '../runtime-client'

/** Re-enter the shipped CLI in the guest, where agent detection and writes belong. */
export async function forwardSkillsToWsl(args: string[], cwd: string): Promise<boolean> {
  const distro = getWslAccountTarget(cwd)?.wslDistro
  if (!distro) {
    return false
  }
  const entry = process.argv[1]
  if (!entry) {
    throw new RuntimeClientError(
      'invalid_environment',
      'Could not locate the bundled Orca CLI for WSL.'
    )
  }
  const guestCwd = parseWslUncPath(cwd)?.linuxPath
  const changeDirectory = guestCwd
    ? quotePosixShell(guestCwd)
    : `"$(wslpath -u ${quotePosixShell(cwd)})"`
  const script = [
    `cd -- ${changeDirectory} || exit 1`,
    'unset ORCA_CLI_CWD ORCA_CLI_WSL_DISTRO NODE_OPTIONS NODE_PATH ELECTRON_RUN_AS_NODE',
    `exec node "$(wslpath -u ${quotePosixShell(entry)})" ${args.map(quotePosixShell).join(' ')}`
  ].join('\n')
  const environment = buildSkillsInstallerEnvironment()
  if (args.includes('--json')) {
    const captured = buildWslCapturedLoginShellCommand(`(\n${script}\n)`)
    const result = await runProcess({
      program: 'wsl.exe',
      args: buildWslExecArgs(distro, ['/bin/sh', '-c', captured.command]),
      env: environment,
      timeoutMs: 30_000
    })
    const output = captured.readStdout(result.stdout)
    if (output !== null) {
      process.stdout.write(output)
    } else if (result.code === 0) {
      throw new RuntimeClientError(
        'invalid_environment',
        'The WSL skills command returned no JSON output.'
      )
    }
    if (result.stderr) {
      process.stderr.write(result.stderr)
    }
    process.exitCode = result.code ?? 1
    return true
  }
  const child = spawnProcess({
    program: 'wsl.exe',
    args: buildWslExecArgs(distro, ['/bin/sh', '-c', buildWslLoginShellCommand(script)]),
    stdio: 'inherit',
    env: environment
  })
  process.exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
  return true
}
