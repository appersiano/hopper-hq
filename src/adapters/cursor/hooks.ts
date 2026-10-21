import { prefixedId } from '../../core/agents.js';
import { mapHookPayload } from '../claude-code/hooks.js';
import { truncate } from '../../core/tool-label.js';
import type { RawEvent } from '../../core/types.js';
import { isSessionId } from '../../scene/text.js';
import { agentId, firstString, hopperTs, object, string } from '../payload.js';

const TO_CLAUDE: Record<string, string> = {
  sessionStart: 'SessionStart',
  sessionEnd: 'SessionEnd',
  beforeSubmitPrompt: 'UserPromptSubmit',
  preToolUse: 'PreToolUse',
  postToolUse: 'PostToolUse',
  postToolUseFailure: 'PostToolUseFailure',
};

/** Cursor's AskQuestion is the same wait as Claude Code's AskUserQuestion. */
function cursorToolName(name: string): string {
  return name === 'AskQuestion' ? 'AskUserQuestion' : name;
}

/** Cursor command hooks. Event names stay camelCase; the collector sees the same events as the other agents. */
export function mapCursorHook(payload: unknown, now: number): RawEvent[] {
  const p = object(payload);
  const rawId = string(p.session_id) || string(p.conversation_id);
  const sessionId = prefixedId('cursor', rawId);
  const cwd = string(p.cwd) || firstString(p.workspace_roots);
  const name = string(p.hook_event_name);
  if (!isSessionId(sessionId) || !cwd || !name) return [];
  const ts = hopperTs(p, now);
  const base = { sessionId, agentKind: 'cursor' as const, source: 'hook' as const, cwd, ts };

  if (name === 'afterAgentResponse') {
    const text = truncate(string(p.text), 2000);
    return text ? [{ ...base, type: 'answer', text }] : [];
  }
  if (name === 'stop') {
    if (p.status === 'aborted') return [{ ...base, type: 'session.status', status: 'idle', waitingFor: null }];
    return [{ ...base, type: 'turn.finished', backgroundTasks: 0 }];
  }
  if (name === 'subagentStart' || name === 'subagentStop') {
    const parent = string(p.parent_conversation_id);
    const parentId = prefixedId('cursor', parent);
    const owner = parent && isSessionId(parentId) ? parentId : sessionId;
    const id = agentId(string(p.subagent_id) || string(p.tool_call_id));
    if (!id) return [];
    if (name === 'subagentStop') return [{ ...base, sessionId: owner, type: 'agent.finished', agentId: id }];
    return [{
      ...base,
      sessionId: owner,
      type: 'agent.started',
      agentId: id,
      agentType: string(p.subagent_type) || 'agent',
      description: truncate(string(p.task) || string(p.description), 200) || null,
    }];
  }

  const claudeName = TO_CLAUDE[name];
  if (!claudeName) return [];
  return mapHookPayload({ ...p, hook_event_name: claudeName, session_id: sessionId, cwd, tool_name: cursorToolName(string(p.tool_name)), agent_id: undefined }, now).map((event) => ({
    ...event,
    agentKind: 'cursor' as const,
    sessionId,
  }));
}
