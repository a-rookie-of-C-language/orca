import { spawnProcess } from '@orca/process-host'
import {
  assertSkillsInstallerNodeVersion,
  resolveBundledSkillsInstaller,
  buildSkillsInstallerEnvironment
} from '../../shared/bundled-skills-installer'
import { quoteStartupArg } from '../../shared/tui-agent-startup-shell'
import { forwardSkillsToWsl } from './skills-wsl-forward'
import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import { getRepeatedStringFlag } from '../flags'
import { writeStdoutLine } from '../stdout-line'
import { loadCanonicalGuides, type BundledSkillGuide } from './bundled-skill-guide-table'
import { SKILL_GUIDE_GET_HANDLER } from './skill-guide-get'

import { isUsableSkillsCliAgentKey } from '../../shared/skills-cli-agent-keys'
import {
  detectSkillsCliAgentKeys,
  detectSkillsCliUpdateAgentKeys
} from '../../shared/skills-cli-agent-detection'
import { buildAgentFeatureSkillInstallArgs } from '../../shared/agent-feature-install-commands'
import { readOrcaCliBuildCommit } from '../cli-version'

function resolveSelectedSkillNames(
  flags: Map<string, string | boolean>,
  guides: BundledSkillGuide[]
): string[] {
  const requestedSkills = getRepeatedStringFlag(flags, 'skill')
  const selectAll = flags.get('all') === true
  if (flags.has('skill') && requestedSkills.length === 0) {
    throw new RuntimeClientError('invalid_argument', 'Missing required --skill')
  }
  if (selectAll && requestedSkills.length > 0) {
    throw new RuntimeClientError('invalid_argument', 'Use either --all or --skill, not both.')
  }
  if (!selectAll && requestedSkills.length === 0) {
    return []
  }
  if (selectAll) {
    return guides.map((guide) => guide.name)
  }
  const availableTopics = guides.map((guide) => guide.name).join(', ')
  const guideByTopic = new Map<string, BundledSkillGuide>(
    guides.flatMap((guide) => [guide.name, ...guide.aliases].map((name) => [name, guide]))
  )
  const canonicalNames = new Set<string>()
  for (const requested of requestedSkills) {
    const guide = guideByTopic.get(requested)
    if (!guide) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Unknown skill "${requested}". Available skills: ${availableTopics}`
      )
    }
    canonicalNames.add(guide.name)
  }
  return [...canonicalNames].sort()
}

function runBundledSkills(args: string[]): Promise<number> {
  assertSkillsInstallerNodeVersion()
  return new Promise((resolve, reject) => {
    const child = spawnProcess({
      program: process.execPath,
      args: [resolveBundledSkillsInstaller(), ...args],
      stdio: 'inherit',
      env: {
        ...buildSkillsInstallerEnvironment(),
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {})
      }
    })
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
}

type SkillMutationVerb = 'install' | 'update'

function resolveAgentKeys(verb: SkillMutationVerb, flags: Map<string, string | boolean>): string[] {
  const requested = flags.get('agent')
  if (flags.has('agent') && typeof requested !== 'string') {
    throw new RuntimeClientError('invalid_argument', 'Missing required --agent')
  }
  if (typeof requested === 'string') {
    // Why: one comma-separated value rather than a repeatable flag — `agent` is a
    // single-value flag on other commands and the repeatable set is process-wide,
    // so making it repeatable here would change how those parse a second --agent.
    const keys = [
      ...new Set(
        requested
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
      )
    ]
    // Why: a value like "," parses to nothing. Falling through to detection would
    // be surprising, and emitting no --agent would restore the all-agents install.
    if (keys.length === 0) {
      throw new RuntimeClientError('invalid_argument', 'Missing required --agent')
    }
    const unusable = keys.find((key) => !isUsableSkillsCliAgentKey(key))
    if (unusable !== undefined) {
      // Why: the skills CLI drops a value starting with `-`, which leaves it with
      // no target and installs into every agent it knows.
      throw new RuntimeClientError(
        'invalid_argument',
        `Invalid --agent value "${unusable}". Pass agent names such as claude-code, ` +
          'codex, or universal.'
      )
    }
    return keys
  }
  if (verb === 'update') {
    return detectSkillsCliUpdateAgentKeys()
  }
  const detected = detectSkillsCliAgentKeys()
  if (detected.length > 0) {
    return detected
  }
  // Why: without --agent, `skills add -y` falls into its own zero-detected branch
  // and installs into every agent it knows (~75), creating config directories for
  // agents this host does not have. Say so instead.
  throw new RuntimeClientError(
    'invalid_environment',
    'No coding agent detected on this host, so there is no install target. Pass ' +
      '--agent <name>[,<name>...] to choose targets explicitly — --agent universal ' +
      'writes only the shared .agents/skills directory that Orca reads.'
  )
}

function buildInstallerArgs(
  skillNames: string[],
  global: boolean,
  agents: string[],
  flags: Map<string, string | boolean>
): string[] {
  const sourceCommit = flags.get('source-commit') ?? readOrcaCliBuildCommit()
  if (typeof sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new RuntimeClientError(
      'invalid_environment',
      'Could not read the commit this Orca CLI was built from, so there is no source to install skills from.'
    )
  }
  return buildAgentFeatureSkillInstallArgs(skillNames, {
    sourceCommit,
    global,
    yes: flags.get('interactive') !== true,
    agents
  }).slice(1)
}

function formatInstallerCommand(args: string[]): string {
  const shell = process.platform === 'win32' ? 'powershell' : 'posix'
  const words = [process.execPath, resolveBundledSkillsInstaller(), ...args].map((word) =>
    /^[a-z0-9_./:@=-]+$/i.test(word) ? word : quoteStartupArg(word, shell)
  )
  return `${shell === 'powershell' ? '& ' : ''}${words.join(' ')}`
}

function formatSkillSelectionHelp(verb: SkillMutationVerb, skillNames: string[]): string {
  return [
    `Choose one or more skills to ${verb}:`,
    ...skillNames.map((name) => `  ${name}`),
    '',
    `Usage: orca skills ${verb} --skill <name> [--skill <name> ...]`,
    `   or: orca skills ${verb} --all`
  ].join('\n')
}

function createSkillMutationHandler(verb: SkillMutationVerb): CommandHandler {
  return async ({ flags, json, cwd }) => {
    const guides = await loadCanonicalGuides()
    const skillNames = resolveSelectedSkillNames(flags, guides)

    if (skillNames.length === 0) {
      const names = guides.map((guide) => guide.name)
      writeStdoutLine(
        json
          ? JSON.stringify({ availableSkills: names }, null, 2)
          : formatSkillSelectionHelp(verb, names)
      )
      return
    }

    const forwarded = ['skills', verb, ...skillNames.flatMap((name) => ['--skill', name])]
    for (const key of [
      'local',
      'dry-run',
      'interactive',
      'locked-installer',
      'json',
      'agent',
      'source-commit'
    ]) {
      const value = flags.get(key)
      if (value === true) {
        forwarded.push(`--${key}`)
      } else if (typeof value === 'string') {
        forwarded.push(`--${key}`, value)
      }
    }
    if (await forwardSkillsToWsl(forwarded, cwd)) {
      return
    }
    if (process.env.ORCA_CLI_CWD) {
      throw new RuntimeClientError(
        'invalid_environment',
        `orca skills ${verb} writes to the machine that runs it. Run it on the intended machine's Orca host.`
      )
    }
    const global = flags.get('local') !== true
    const agents =
      flags.get('interactive') === true && !flags.has('agent') ? [] : resolveAgentKeys(verb, flags)
    const installerArgs = buildInstallerArgs(skillNames, global, agents, flags)
    const command = formatInstallerCommand(installerArgs)
    const dryRun = flags.get('dry-run') === true

    if (dryRun) {
      writeStdoutLine(
        json
          ? JSON.stringify({ command, skills: skillNames, global, executed: false }, null, 2)
          : `${command}\n\nRerun without --dry-run to ${verb} now.`
      )
      return
    }

    if (json) {
      // Why: a real run inherits the installer's own stdout so progress stays visible live;
      // that stream is not JSON, so --json can't be honored here.
      throw new RuntimeClientError(
        'invalid_argument',
        `orca skills ${verb} --json only supports --dry-run. Real ${verb}s stream ` +
          "the installer's own output, which isn't JSON."
      )
    }

    // Why: stdio is inherited for the child below, so this status line must go to
    // stderr — stdout is the installer's own output, not this command's JSON channel.
    process.stderr.write(`Running: ${command}\n`)
    process.exitCode = await runBundledSkills(installerArgs)
  }
}

export const SKILL_HANDLERS: Record<string, CommandHandler> = {
  'skills list': async ({ json }) => {
    // Why: generated registry order is not a user-facing contract, while stable
    // canonical sorting keeps agent-visible output reproducible across builds.
    const topics = (await loadCanonicalGuides()).map((guide) => ({
      name: guide.name,
      description: guide.description.replace(/\s+/g, ' ').trim()
    }))
    writeStdoutLine(
      json
        ? JSON.stringify({ topics }, null, 2)
        : topics.map((topic) => `${topic.name}: ${topic.description}`).join('\n')
    )
  },
  ...SKILL_GUIDE_GET_HANDLER,
  'skills install': createSkillMutationHandler('install'),
  'skills update': createSkillMutationHandler('update')
}
