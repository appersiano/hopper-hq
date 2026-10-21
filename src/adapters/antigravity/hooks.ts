import { prefixedId } from '../../core/agents.js';
import { toolLabel, truncate } from '../../core/tool-label.js';
import type { RawEvent, WaitReason } from '../../core/types.js';
import { isSessionId } from '../../scene/text.js';
import { agentId, firstString, hopperTs, object, string } from '../payload.js';

function waitFor(name: string, args: unknown): WaitReason | null {
  if (name === 'ask_question') {
    const text = questionText(args);
    return { kind: 'question', text: truncate(text, 120) || 'Question' };
  }
  if (name === 'ask_permission') {
    const record = object(args);
    const text = truncate(string(record.Reason) || string(record.reason) || string(record.Action) || 'Permission', 120);
    return { kind: 'permission', text, ...(string(record.Target) ? { detail: truncate(string(record.Target), 80) } : {}) };
  }
  return null;
}

function questionText(args: unknown): string {
  const record = object(args);
  let questions: unknown = record.questions ?? record.Questions;
  if (typeof questions === 'string') {
    try {
      questions = JSON.parse(questions);
    } catch {
      questions = [];
    }
  }
  const first = Array.isArray(questions) ? object(questions[0]) : {};
  return string(first.question) || string(first.Question) || string(record.question);
}

function subagents(args: unknown, step: number, base: { sessionId: string; cwd: string; ts: number; source: 'hook' }, starting: boolean): RawEvent[] {
  const list = object(args).Subagents;
  if (!Array.isArray(list)) return [];
  const events: RawEvent[] = [];
  list.forEach((item, index) => {
    const spec = object(item);
    const id = agentId(`ag-${step}-${index}`);
    if (!id) return;
    if (!starting) {
      events.push({ ...base, agentKind: 'antigravity', type: 'agent.finished', agentId: id });
      return;
    }
    events.push({
      ...base,
      agentKind: 'antigravity',
      type: 'agent.started',
      agentId: id,
      agentType: string(spec.TypeName) || string(spec.Role) || 'agent',
      description: truncate(string(spec.Prompt) || string(spec.Role), 200) || null,
    });
  });
  return events;
}

/** Antigravity command hooks. The event name is not in the payload, so the CLI command supplies it. */
export function mapAntigravityHook(payload: unknown, now: number): RawEvent[] {
  const p = object(payload);
  const rawId = string(p.conversationId) || string(p.session_id);
  const sessionId = prefixedId('antigravity', rawId);
  const cwd = string(p.cwd) || firstString(p.workspacePaths);
  const name = string(p.hook_event_name);
  if (!isSessionId(sessionId) || !cwd || !name) return [];
  const ts = hopperTs(p, now);
  const base = { sessionId, agentKind: 'antigravity' as const, source: 'hook' as const, cwd, ts };
  const call = object(p.toolCall);
  const toolName = string(call.name);
  const step = Number.isInteger(p.stepIdx) ? (p.stepIdx as number) : 0;

  switch (name) {
    case 'SessionStart':
      return [{ ...base, type: 'session.started' }];
    case 'PreInvocation':
      return [{ ...base, type: 'session.status', status: 'busy', waitingFor: null }];
    case 'PostInvocation':
      return [];
    case 'Stop':
      return [{ ...base, type: 'turn.finished', backgroundTasks: p.fullyIdle === false ? 1 : 0 }];
    case 'PreToolUse': {
      if (!toolName) return [];
      const wait = waitFor(toolName, call.args);
      const events: RawEvent[] = wait
        ? [{ ...base, type: 'waiting', reason: wait, agentId: null }]
        : [{ ...base, type: 'tool.started', toolId: null, tool: toolName, label: toolLabel(toolName, call.args, cwd), agentId: null }];
      if (toolName === 'invoke_subagent') events.push(...subagents(call.args, step, base, true));
      return events;
    }
    case 'PostToolUse': {
      const events: RawEvent[] = [{ ...base, type: 'tool.finished', toolId: null, ok: !string(p.error), agentId: null }];
      if (toolName === 'invoke_subagent') events.push(...subagents(call.args, step, base, false));
      return events;
    }
    default:
      return [];
  }
}
