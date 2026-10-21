import type { AgentKind } from './types.js';

export const AGENT_LABEL: Record<AgentKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
};

/** Rollout and transcript discovery can replay a finished desk long after its agent has exited. */
export function fileDiscovered(kind: AgentKind): boolean {
  return kind === 'codex' || kind === 'cursor' || kind === 'antigravity';
}

/** The id stored on a desk. Claude Code ids are already unique; the others are prefixed so two agents cannot share one. */
export function prefixedId(kind: Exclude<AgentKind, 'claude-code'>, id: string): string {
  return `${kind}-${id}`;
}

/** The id without the agent prefix nameOf and the attention line show. */
export function unprefixedId(kind: AgentKind, id: string): string {
  const prefix = `${kind}-`;
  return kind !== 'claude-code' && id.startsWith(prefix) ? id.slice(prefix.length) : id;
}
