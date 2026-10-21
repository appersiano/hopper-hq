import { prefixedId } from '../../core/agents.js';
import { truncate } from '../../core/tool-label.js';
import type { RawEvent } from '../../core/types.js';
import { firstString, object, string } from '../payload.js';

export interface AntigravityParse {
  events: RawEvent[];
  skipped: number;
  cwd?: string;
}

const KNOWN = new Set(['CHECKPOINT', 'CONVERSATION_HISTORY']);

/** One step of `transcript.jsonl` / `transcript_full.jsonl`. A line that is not a step is counted and skipped. */
export function parseAntigravityLine(line: string, context: { sessionId: string; cwd: string }): AntigravityParse {
  let record: Record<string, unknown>;
  try {
    record = object(JSON.parse(line));
  } catch {
    return { events: [], skipped: 1 };
  }
  const ts = Date.parse(string(record.created_at));
  if (!Number.isFinite(ts)) return { events: [], skipped: 1 };
  const cwd = firstString(record.workspacePaths) || string(record.cwd) || context.cwd;
  const base = { sessionId: context.sessionId, cwd, ts, source: 'fs' as const, agentKind: 'antigravity' as const };
  const type = string(record.type);
  const source = string(record.source);
  if (source === 'SYSTEM' || KNOWN.has(type)) return { events: [], skipped: 0, ...(cwd !== context.cwd ? { cwd } : {}) };

  const events: RawEvent[] = [];
  if (source === 'USER_EXPLICIT' || type === 'USER_INPUT') {
    const text = userRequest(string(record.content));
    if (text) events.push({ ...base, type: 'prompt', text });
    return { events, skipped: events.length || type || source ? 0 : 1, ...(cwd !== context.cwd ? { cwd } : {}) };
  }

  const calls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
  if (type === 'PLANNER_RESPONSE' || source === 'MODEL' || calls.length > 0) {
    const reply = truncate(string(record.content), 2000);
    if (reply && type !== 'INVOKE_SUBAGENT') events.push({ ...base, type: 'answer', text: reply });
    let waiting = false;
    for (const call of calls) {
      const tool = object(call);
      const name = string(tool.name) || string(tool.tool);
      if (!name) continue;
      const args = argsOf(tool.args ?? tool.arguments);
      if (name === 'ask_question' || name === 'ask_permission') {
        waiting = true;
        const recordArgs = object(args);
        const text = name === 'ask_permission'
          ? truncate(string(recordArgs.Reason) || string(recordArgs.reason) || 'Permission', 120)
          : truncate(questionOf(args), 120) || 'Question';
        events.push({ ...base, type: 'waiting', reason: { kind: name === 'ask_permission' ? 'permission' : 'question', text }, agentId: null });
        continue;
      }
      const detail = string(object(args).CommandLine) || string(object(args).command);
      events.push({ ...base, type: 'tool.started', toolId: null, tool: name, label: truncate(detail ? `${name}: ${detail.split('\n')[0]}` : name), agentId: null });
    }
    if (record.status === 'ERROR') events.push({ ...base, type: 'tool.finished', toolId: null, ok: false, agentId: null });
    else if (record.status === 'DONE' && !waiting && (type === 'PLANNER_RESPONSE' || calls.length === 0) && calls.length === 0) events.push({ ...base, type: 'turn.finished', backgroundTasks: 0 });
    return { events, skipped: events.length ? 0 : 1, ...(cwd !== context.cwd ? { cwd } : {}) };
  }
  return { events: [], skipped: 1 };
}

function userRequest(content: string): string | null {
  const wrapped = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  const body = wrapped?.[1] ?? content.replace(/<ADDITIONAL_METADATA>[\s\S]*$/, '');
  return truncate(body, 2000) || null;
}

function argsOf(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

function questionOf(args: unknown): string {
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

export function antigravitySessionId(id: string): string {
  return prefixedId('antigravity', id);
}
