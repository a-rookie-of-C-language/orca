import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertSkillsInstallerNodeVersion,
  buildSkillsInstallerEnvironment,
  resolveBundledSkillsInstaller
} from './bundled-skills-installer'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('locked skills installer', () => {
  it('explains unsupported host Node versions without downloading a runtime', () => {
    for (const version of ['18.20.0', '20.19.0', '22.19.0']) {
      expect(() => assertSkillsInstallerNodeVersion(version)).toThrow('requires Node.js 22.20.0')
    }
    for (const version of ['22.20.0', '24.0.0']) {
      expect(() => assertSkillsInstallerNodeVersion(version)).not.toThrow()
    }
  })
  it('uses the unpacked application artifact and fails closed when absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-locked-skills-'))
    directories.push(root)
    const runtimeDirectory = join(root, 'app.asar', 'out', 'main')
    expect(() => resolveBundledSkillsInstaller(runtimeDirectory)).toThrow(
      'no package will be downloaded'
    )
    const installer = join(
      root,
      'app.asar.unpacked',
      'out',
      'cli',
      'skills-installer',
      'dist',
      'cli.mjs'
    )
    mkdirSync(join(installer, '..'), { recursive: true })
    writeFileSync(installer, '')
    expect(resolveBundledSkillsInstaller(runtimeDirectory)).toBe(installer)
  })

  it('keeps custom community-agent roots while dropping executable source overrides', () => {
    expect(
      buildSkillsInstallerEnvironment({
        HERMES_HOME: '/agents/hermes',
        VIBE_HOME: '/agents/vibe',
        AUTOHAND_HOME: '/agents/autohand',
        SARVAM_HOME: '/agents/sarvam',
        FLATPAK_XDG_CONFIG_HOME: '/flatpak/config',
        SKILLS_DOWNLOAD_URL: 'https://untrusted.example',
        SKILLS_API_URL: 'https://untrusted.example'
      })
    ).toEqual({
      HERMES_HOME: '/agents/hermes',
      VIBE_HOME: '/agents/vibe',
      AUTOHAND_HOME: '/agents/autohand',
      SARVAM_HOME: '/agents/sarvam',
      FLATPAK_XDG_CONFIG_HOME: '/flatpak/config',
      LC_ALL: 'C',
      DISABLE_TELEMETRY: '1'
    })
  })

  it('preserves homes and proxy access without passing credentials or Node loaders', () => {
    expect(
      buildSkillsInstallerEnvironment({
        HOME: '/home/ada',
        PATH: '/bin',
        CLAUDE_CONFIG_DIR: '/profiles/ada',
        HTTPS_PROXY: 'http://proxy:8080',
        SSH_AUTH_SOCK: '/socket',
        OPENAI_API_KEY: 'secret',
        GH_TOKEN: 'secret',
        NPM_TOKEN: 'secret',
        NODE_OPTIONS: '--require=/tmp/loader.js',
        NODE_PATH: '/injected',
        LC_ALL: 'ko_KR.UTF-8'
      })
    ).toEqual({
      HOME: '/home/ada',
      PATH: '/bin',
      CLAUDE_CONFIG_DIR: '/profiles/ada',
      HTTPS_PROXY: 'http://proxy:8080',
      SSH_AUTH_SOCK: '/socket',
      LC_ALL: 'C',
      DISABLE_TELEMETRY: '1'
    })
  })
})
