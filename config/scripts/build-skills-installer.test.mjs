import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isBuiltin } from 'node:module'
import { describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { buildSkillsInstaller } from './build-skills-installer.mjs'
import { buildOrcadCli } from './orcad-entry-build.mjs'
import { SKILLS_CLI_VERSION } from '../../src/shared/agent-feature-install-commands'
import { buildSkillsInstallerEnvironment } from '../../src/shared/bundled-skills-installer'

describe('packaged locked skills installer', () => {
  it('installs and replaces a selected local skill after relocating away from node_modules', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'orca-installer-package-'))
    try {
      const output = join(temporary, 'build')
      const deployed = join(temporary, 'relocated', 'out', 'cli')
      const result = await buildSkillsInstaller(output)
      const externals = Object.values(result.metafile.outputs)
        .flatMap((output) => output.imports)
        .filter((entry) => entry.external)
      expect(externals.every((entry) => isBuiltin(entry.path))).toBe(true)
      await mkdir(deployed, { recursive: true })
      await cp(join(output, 'skills-installer'), join(deployed, 'skills-installer'), {
        recursive: true
      })
      await rm(output, { recursive: true })
      const source = join(temporary, 'source', 'test-tool')
      const home = join(temporary, 'home')
      await mkdir(source, { recursive: true })
      await mkdir(home)
      await writeFile(
        join(source, 'SKILL.md'),
        '---\nname: test-tool\ndescription: Test installing the locked artifact.\n---\nFirst version.\n'
      )
      const notices = await readFile(
        join(deployed, 'skills-installer', 'ThirdPartyNoticeText.txt'),
        'utf8'
      )
      for (const name of [
        'tar@',
        '@isaacs/fs-minipass@',
        'chownr@',
        'minipass@',
        'minizlib@',
        'yallist@',
        'yaml@'
      ]) {
        expect(notices).toContain(`Bundled dependency: ${name}`)
      }
      const program = join(deployed, 'skills-installer', 'dist', 'cli.mjs')
      const environment = {
        ...buildSkillsInstallerEnvironment(),
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_CACHE_HOME: join(home, '.cache'),
        NODE_PATH: '',
        NODE_OPTIONS: '',
        DISABLE_TELEMETRY: '1',
        ORCA_BACKGROUND_LAUNCH: '1'
      }
      const version = await runProcess({
        program: process.execPath,
        args: [program, '--version'],
        env: environment,
        cwd: temporary
      })
      expect(version.stdout.trim()).toBe(SKILLS_CLI_VERSION)
      const args = [
        program,
        'add',
        join(temporary, 'source'),
        '--skill',
        'test-tool',
        '--global',
        '--agent',
        'universal',
        '-y'
      ]
      const first = await runProcess({
        program: process.execPath,
        args,
        env: environment,
        cwd: temporary,
        timeoutMs: 30_000
      })
      expect(first.code, first.stdout + first.stderr).toBe(0)
      const installed = join(home, '.agents', 'skills', 'test-tool', 'SKILL.md')
      expect(await readFile(installed, 'utf8')).toContain('First version.')
      await writeFile(installed, 'Local drift.\n')
      await writeFile(
        join(source, 'SKILL.md'),
        '---\nname: test-tool\ndescription: Test installing the locked artifact.\n---\nSecond version.\n'
      )
      const second = await runProcess({
        program: process.execPath,
        args,
        env: environment,
        cwd: temporary,
        timeoutMs: 30_000
      })
      expect(second.code, second.stdout + second.stderr).toBe(0)
      expect(await readFile(installed, 'utf8')).toContain('Second version.')
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }, 60_000)

  it('resolves the installer from a standalone SSH CLI after deployment', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'orca-ssh-skills-'))
    try {
      const source = join(temporary, 'build', 'out', 'cli')
      await mkdir(source, { recursive: true })
      await buildOrcadCli(join(source, 'index.js'))
      await buildSkillsInstaller(source)
      const deployed = join(temporary, 'host', 'out', 'cli')
      await mkdir(deployed, { recursive: true })
      await cp(source, deployed, { recursive: true })
      await rm(join(temporary, 'build'), { recursive: true })
      const result = await runProcess({
        program: process.execPath,
        args: [
          join(deployed, 'index.js'),
          'skills',
          'install',
          '--skill',
          'orca-cli',
          '--agent',
          'universal',
          '--source-commit',
          'a'.repeat(40),
          '--dry-run',
          '--json',
          '--locked-installer'
        ],
        cwd: temporary,
        env: {
          ...buildSkillsInstallerEnvironment(),
          ORCA_CLI_CWD: '',
          NODE_OPTIONS: '',
          NODE_PATH: '',
          ORCA_BACKGROUND_LAUNCH: '1'
        },
        timeoutMs: 30_000
      })
      expect(result.code, result.stdout + result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        executed: false,
        skills: ['orca-cli'],
        command: expect.stringContaining(join(deployed, 'skills-installer', 'dist', 'cli.mjs'))
      })
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }, 60_000)
})
