import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { Readable } from 'node:stream';
import { decodeCursorProject } from '../../src/adapters/cursor/project-path.js';
import { cursorHookResponse, forwardCursorHook } from '../../src/adapters/cursor/forward.js';
import { CursorAdapter } from '../../src/adapters/cursor/fs-adapter.js';
import { mapCursorHook } from '../../src/adapters/cursor/hooks.js';
import { cursorSessionId, parseCursorLine } from '../../src/adapters/cursor/transcript.js';
import { Collector } from '../../src/collector.js';

const cwd = '/work/api';
const id = '11111111-1111-4111-8111-111111111111';
const sessionId = cursorSessionId(id);
const resolveWorkspace = async (dir: string) => ({ cwd: dir, root: dir, repoRoot: dir, repoName: 'api', branch: 'feat/login', worktree: false });
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('Cursor transcripts and hooks', () => {
  it('reads a chat, a shell call and a question without treating a question as a finished tool', () => {
    const lines = [
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<timestamp>now</timestamp>\n<user_query>\nAdd login\n</user_query>' }] } }),
      JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Shell', input: { command: 'npm test' } }] } }),
      JSON.stringify({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'AskQuestion', input: { questions: [{ question: 'Which database?' }] } }] } }),
      JSON.stringify({ type: 'turn_ended', status: 'success' }),
    ];
    const events = lines.flatMap((line) => parseCursorLine(line, { sessionId, cwd, ts: 50 }).events);
    expect(events.map((event) => event.type)).toEqual(['prompt', 'answer', 'tool.started', 'waiting', 'turn.finished']);
    expect(events[1]).toMatchObject({ type: 'answer', text: 'Looking.' });
    expect(events[2]).toMatchObject({ type: 'tool.started', tool: 'Shell', label: 'Shell: npm test' });
    expect(events[3]).toMatchObject({ type: 'waiting', reason: { kind: 'question', text: 'Which database?' } });
  });

  it('maps live hooks onto the parent session and allows the tool', () => {
    const seen = mapCursorHook({
      hook_event_name: 'preToolUse', conversation_id: id, cwd, tool_name: 'Shell', tool_input: { command: 'pwd' }, tool_use_id: 'call-1',
    }, 10);
    expect(seen[0]).toMatchObject({ type: 'tool.started', sessionId, agentKind: 'cursor', label: 'Shell: pwd' });
    const child = mapCursorHook({
      hook_event_name: 'subagentStart', conversation_id: 'child', parent_conversation_id: id, cwd, subagent_id: 'sub-1', subagent_type: 'explore', task: 'Find the login form',
    }, 11);
    expect(child[0]).toMatchObject({ type: 'agent.started', sessionId, agentId: 'sub-1', agentType: 'explore' });
    expect(mapCursorHook({ hook_event_name: 'stop', conversation_id: id, cwd, status: 'completed' }, 12)[0]).toMatchObject({ type: 'turn.finished' });
    expect(cursorHookResponse('preToolUse')).toEqual({ permission: 'allow' });
    expect(cursorHookResponse('beforeSubmitPrompt')).toEqual({ continue: true });
  });

  it('decodes a project folder by treating hyphens as path separators when the directory exists', async () => {
    const dirsOnDisk = new Set(['/Users', '/Users/me', '/Users/me/my-app']);
    await expect(decodeCursorProject('Users-me-my-app', async (path) => dirsOnDisk.has(path))).resolves.toBe('/Users/me/my-app');
    await expect(decodeCursorProject('Users-me-missing', async (path) => dirsOnDisk.has(path))).resolves.toBeNull();
  });

  it('discovers a transcript under the project folder Cursor would name for that directory', async () => {
    const work = await mkdtemp(join(tmpdir(), 'hoppercursor'));
    dirs.push(work);
    const slug = work.slice(1).replaceAll('/', '-');
    const cursorDir = join(work, 'cursor-home');
    const transcript = join(cursorDir, 'projects', slug, 'agent-transcripts', id, `${id}.jsonl`);
    await mkdir(join(transcript, '..'), { recursive: true });
    await writeFile(transcript, `${JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>Add login</user_query>' }] } })}\n${JSON.stringify({ type: 'turn_ended', status: 'success' })}\n`);
    const events: unknown[] = [];
    const adapter = new CursorAdapter({
      cursorDir,
      emit: (event) => events.push(event),
      resolveWorkspace,
      now: () => Date.now(),
    });
    await adapter.poll();
    adapter.stop();
    expect(events.map((event) => (event as { type: string }).type)).toEqual(['session.seen', 'prompt', 'turn.finished']);
  });

  it('forwards a hook and still allows the tool when the daemon is down', async () => {
    let written = '';
    const out = new Writable({ write(chunk, _enc, cb) { written += String(chunk); cb(); } });
    await forwardCursorHook(Readable.from([JSON.stringify({ hook_event_name: 'preToolUse', conversation_id: id, cwd })]), { HOPPER_HQ_HOME: '/missing/hopper' }, out);
    expect(written).toBe('{"permission":"allow"}\n');
  });

  it('shares a floor with another agent', async () => {
    const collector = new Collector({ resolveWorkspace, now: () => 10_000 });
    await collector.ingest({ type: 'session.seen', source: 'fs', sessionId, cwd, ts: 1, workspace: await resolveWorkspace(cwd), agentKind: 'cursor' });
    await collector.ingest({ type: 'prompt', source: 'hook', sessionId, agentKind: 'cursor', cwd, ts: 2, text: 'Add login' });
    expect(collector.session(sessionId)).toMatchObject({ agentKind: 'cursor', state: 'working' });
    expect(collector.snapshot().floors).toHaveLength(1);
    await collector.close();
  });
});
