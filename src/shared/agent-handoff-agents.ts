// Agents whose transcripts Orca can decode into provider-neutral handoff text.
// Shared so main (parsers) and renderer (continuation flow) agree on the set.
export const HANDOFF_AGENTS = ['claude', 'codex', 'pi'] as const

export type HandoffAgent = (typeof HANDOFF_AGENTS)[number]

const HANDOFF_AGENT_SET: ReadonlySet<string> = new Set(HANDOFF_AGENTS)

export function isHandoffAgent(value: unknown): value is HandoffAgent {
  return typeof value === 'string' && HANDOFF_AGENT_SET.has(value)
}
