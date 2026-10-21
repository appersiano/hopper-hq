import { Writable } from 'node:stream';
import { forwardHook } from '../forward.js';
import { firstString, string } from '../payload.js';

/** The answer a gating Cursor hook must print, or the tool call is blocked. */
export function cursorHookResponse(eventName: string): Record<string, unknown> {
  if (eventName === 'preToolUse' || eventName === 'subagentStart') return { permission: 'allow' };
  if (eventName === 'beforeSubmitPrompt') return { continue: true };
  return {};
}

function prepareCursor(payload: Record<string, unknown>): boolean {
  const id = string(payload.session_id) || string(payload.conversation_id);
  const name = string(payload.hook_event_name);
  if (!id || !name) return false;
  payload.session_id = id;
  if (!string(payload.cwd)) {
    const root = firstString(payload.workspace_roots);
    if (root) payload.cwd = root;
  }
  return true;
}

export async function forwardCursorHook(input: AsyncIterable<Buffer | string> = process.stdin, env = process.env, out: Writable = process.stdout): Promise<void> {
  const payload = await forwardHook('/api/hooks/cursor', input, env, prepareCursor);
  const name = string(payload?.hook_event_name);
  out.write(`${JSON.stringify(cursorHookResponse(name))}\n`);
}
