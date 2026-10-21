import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { forwardAntigravityHook, inferAntigravityEvent } from '../../src/adapters/antigravity/forward.js';
import { AntigravityAdapter } from '../../src/adapters/antigravity/fs-adapter.js';
import { mapAntigravityHook } from '../../src/adapters/antigravity/hooks.js';
import { antigravitySessionId, parseAntigravityLine } from '../../src/adapters/antigravity/transcript.js';
import { Collector } from '../../src/collector.js';

const cwd = '/work/api';
const id = '22222222-2222-4222-8222-222222222222';
const sessionId = antigravitySessionId(id);
const resolveWorkspace = async (dir: string) => ({ cwd: dir, root: dir, repoRoot: dir, repoName: 'api', branch: 'feat/login', worktree: false });
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const step = (fields: Record<string, unknown>) => JSON.stringify({ created_at: '2026-10-21T08:00:00.000Z', status: 'DONE', ...fields });

describe('Antigravity transcripts and hooks', () => {
  it('reads a user request, a reply and an open question', () => {
    const lines = [
      step({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>Add login</USER_REQUEST><ADDITIONAL_METADATA>secret</ADDITIONAL_METADATA>' }),
      step({ source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'Which one?', tool_calls: [{ name: 'ask_question', args: { questions: [{ question: 'Which database?' }] } }] }),
      step({ source: 'SYSTEM', type: 'CHECKPOINT' }),
    ];
    const parsed = lines.map((line) => parseAntigravityLine(line, { sessionId, cwd }));
    expect(parsed[0]!.events[0]).toMatchObject({ type: 'prompt', text: 'Add login' });
    expect(parsed[1]!.events.map((event) => event.type)).toEqual(['answer', 'waiting']);
    expect(parsed[1]!.events[1]).toMatchObject({ reason: { kind: 'question', text: 'Which database?' } });
    expect(parsed[2]).toEqual({ events: [], skipped: 0 });
  });

  it('maps a permission wait and a subagent onto the conversation', () => {
    const events = mapAntigravityHook({
      hook_event_name: 'PreToolUse',
      conversationId: id,
      workspacePaths: [cwd],
      stepIdx: 4,
      toolCall: { name: 'invoke_subagent', args: { Subagents: [{ TypeName: 'explore', Prompt: 'Find the login form', Role: 'explorer' }] } },
    }, 20);
    expect(events.map((event) => event.type)).toEqual(['tool.started', 'agent.started']);
    expect(events[1]).toMatchObject({ sessionId, agentKind: 'antigravity', agentType: 'explore', agentId: 'ag-4-0' });
    const permission = mapAntigravityHook({
      hook_event_name: 'PreToolUse', conversationId: id, cwd, toolCall: { name: 'ask_permission', args: { Reason: 'Run tests', Target: 'npm test' } },
    }, 21);
    expect(permission[0]).toMatchObject({ type: 'waiting', reason: { kind: 'permission', text: 'Run tests' } });
    expect(inferAntigravityEvent({ toolCall: { name: 'run_command' }, error: '' })).toBe('PostToolUse');
  });

  it('follows a CLI transcript once when the same id also exists for the IDE', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hoppergemini'));
    dirs.push(root);
    const write = async (product: string) => {
      const logs = join(root, product, 'brain', id, '.system_generated', 'logs');
      await mkdir(logs, { recursive: true });
      await writeFile(join(logs, 'transcript.jsonl'), `${step({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: product })}\n`);
    };
    await write('antigravity-cli');
    await write('antigravity-ide');
    await mkdir(join(root, 'antigravity-cli', 'cache'), { recursive: true });
    await writeFile(join(root, 'antigravity-cli', 'cache', 'last_conversations.json'), JSON.stringify({ [cwd]: id }));
    const events: { type: string; text?: string }[] = [];
    const adapter = new AntigravityAdapter({ geminiDir: root, emit: (event) => events.push(event as { type: string; text?: string }), resolveWorkspace });
    await adapter.poll();
    adapter.stop();
    expect(events.map((event) => event.type)).toEqual(['session.seen', 'prompt']);
    expect(events[1]?.text).toBe('antigravity-cli');
  });

  it('answers PreToolUse with allow when the daemon is down', async () => {
    let written = '';
    const out = new Writable({ write(chunk, _enc, cb) { written += String(chunk); cb(); } });
    await forwardAntigravityHook(Readable.from([JSON.stringify({ conversationId: id, workspacePaths: [cwd], toolCall: { name: 'run_command', args: {} } })]), { HOPPER_HQ_HOME: '/missing/hopper' }, 'PreToolUse', out);
    expect(written).toBe('{"decision":"allow"}\n');
  });

  it('keeps a question open on the conversation desk', async () => {
    const collector = new Collector({ resolveWorkspace, now: () => Date.parse('2026-10-21T08:00:05.000Z') });
    const line = step({ source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'Need a choice', tool_calls: [{ name: 'ask_question', args: '{"questions":[{"question":"Which database?"}]}' }] });
    await collector.ingest({ type: 'session.seen', source: 'fs', sessionId, cwd, ts: 1, workspace: await resolveWorkspace(cwd), agentKind: 'antigravity' });
    for (const event of parseAntigravityLine(line, { sessionId, cwd }).events) await collector.ingest(event);
    expect(collector.session(sessionId)).toMatchObject({ agentKind: 'antigravity', state: 'needs_you' });
    await collector.close();
  });
});
