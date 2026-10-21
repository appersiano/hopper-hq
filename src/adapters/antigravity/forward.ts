import { Writable } from 'node:stream';
import { forwardHook } from '../forward.js';
import { firstString, object, string } from '../payload.js';

/** Antigravity's PreToolUse and Stop require a decision. Anything other than `continue` on Stop lets the turn end. */
export function antigravityHookResponse(eventName: string): Record<string, unknown> {
  if (eventName === 'PreToolUse') return { decision: 'allow' };
  if (eventName === 'Stop') return { decision: 'allow' };
  return {};
}

/** The payload omits the event name. The command argument wins; the shape is only a fallback. */
export function inferAntigravityEvent(payload: Record<string, unknown>): string {
  if (typeof payload.terminationReason === 'string' || typeof payload.fullyIdle === 'boolean') return 'Stop';
  if (object(payload.toolCall).name) return 'error' in payload ? 'PostToolUse' : 'PreToolUse';
  if (typeof payload.invocationNum === 'number') return 'PreInvocation';
  return 'SessionStart';
}

function prepare(eventName: string | undefined) {
  return (payload: Record<string, unknown>): boolean => {
    const id = string(payload.conversationId) || string(payload.session_id);
    const name = eventName || string(payload.hook_event_name) || inferAntigravityEvent(payload);
    if (!id || !name) return false;
    payload.session_id = id;
    payload.hook_event_name = name;
    if (!string(payload.cwd)) {
      const root = firstString(payload.workspacePaths);
      if (root) payload.cwd = root;
    }
    return Boolean(string(payload.cwd));
  };
}

export async function forwardAntigravityHook(
  input: AsyncIterable<Buffer | string> = process.stdin,
  env = process.env,
  eventName?: string,
  out: Writable = process.stdout,
): Promise<void> {
  const payload = await forwardHook('/api/hooks/antigravity', input, env, prepare(eventName));
  const name = eventName || string(payload?.hook_event_name);
  out.write(`${JSON.stringify(antigravityHookResponse(name))}\n`);
}
