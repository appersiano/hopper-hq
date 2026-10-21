import { prefixedId } from '../../core/agents.js';
import { truncate, waitingFromTool } from '../../core/tool-label.js';
import type { RawEvent } from '../../core/types.js';
import { agentId, object, string } from '../payload.js';

export interface CursorParse {
  events: RawEvent[];
  skipped: number;
}

/** One JSONL record from `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`. Internal format: a bad line is skipped. */
export function parseCursorLine(line: string, context: { sessionId: string; cwd: string; ts: number }): CursorParse {
  let record: Record<string, unknown>;
  try {
    record = object(JSON.parse(line));
  } catch {
    return { events: [], skipped: 1 };
  }
  const base = { sessionId: context.sessionId, cwd: context.cwd, ts: context.ts, source: 'fs' as const, agentKind: 'cursor' as const };
  if (record.type === 'turn_ended') {
    if (record.status === 'aborted') return { events: [{ ...base, type: 'session.status', status: 'idle', waitingFor: null }], skipped: 0 };
    return { events: [{ ...base, type: 'turn.finished', backgroundTasks: 0 }], skipped: 0 };
  }
  const role = string(record.role);
  const content = object(record.message).content;
  if (role === 'user') {
    const text = userText(content);
    return text ? { events: [{ ...base, type: 'prompt', text }], skipped: 0 } : { events: [], skipped: 0 };
  }
  if (role !== 'assistant' || !Array.isArray(content)) return { events: [], skipped: role || record.type ? 1 : 0 };

  const events: RawEvent[] = [];
  let tools = 0;
  let wrote = false;
  for (const block of content) {
    const part = object(block);
    if (part.type === 'text') {
      const text = truncate(string(part.text), 2000);
      if (text) {
        events.push({ ...base, type: 'answer', text });
        wrote = true;
      }
      continue;
    }
    if (part.type !== 'tool_use') continue;
    tools++;
    const name = string(part.name);
    if (!name) continue;
    const input = part.input;
    const wait = waitingFromTool(name === 'AskQuestion' ? 'AskUserQuestion' : name, input);
    if (wait) {
      events.push({ ...base, type: 'waiting', reason: wait, agentId: null });
      continue;
    }
    const id = agentId(string(part.id));
    events.push({
      ...base,
      type: 'tool.started',
      toolId: id,
      tool: name,
      label: toolText(name, input),
      agentId: null,
    });
  }
  if (wrote && tools === 0) events.push({ ...base, type: 'turn.finished', backgroundTasks: 0 });
  return { events, skipped: 0 };
}

function userText(content: unknown): string | null {
  const raw = texts(content).join('\n');
  const query = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  const body = (query?.[1] ?? raw).replace(/<timestamp>[\s\S]*?<\/timestamp>/g, '');
  return truncate(body, 2000) || null;
}

function texts(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.map((block) => string(object(block).text)).filter((text) => text !== '');
}

function toolText(name: string, input: unknown): string {
  const record = object(input);
  const command = string(record.command).split('\n')[0] ?? '';
  if (name === 'Shell' || name === 'Bash') return truncate(`${name}: ${command}`);
  if (name === 'Task') return truncate(`Agent: ${string(record.description) || string(record.subagent_type) || 'subagent'}`);
  const file = string(record.path) || string(record.file_path) || string(record.target_file);
  return truncate(file ? `${name} ${file.split('/').filter(Boolean).slice(-2).join('/')}` : name);
}

export function cursorSessionId(id: string): string {
  return prefixedId('cursor', id);
}
