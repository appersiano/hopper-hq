import { afterEach, expect, it } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Collector } from '../../src/collector.js';
import { createApiServer } from '../../src/server/http.js';
import { forwardCursorHook } from '../../src/adapters/cursor/forward.js';
import { forwardAntigravityHook } from '../../src/adapters/antigravity/forward.js';
import { bearer, call, close, listen } from '../helpers/http.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

it('accepts Cursor and Antigravity hooks on their own routes', async () => {
  const collector = new Collector({ resolveWorkspace: async (cwd) => ({ cwd, repoRoot: cwd, repoName: 'api', branch: 'main', worktree: false }) });
  const server = createApiServer({ collector, token: 'test-token' });
  const port = await listen(server);
  const dataDir = await mkdtemp(join(tmpdir(), 'hopper-extra-hook-'));
  dirs.push(dataDir);
  await writeFile(join(dataDir, 'daemon.json'), JSON.stringify({ port, token: 'test-token', pid: process.pid, startedAt: Date.now() }));
  const cursorBody = JSON.stringify({ hook_event_name: 'beforeSubmitPrompt', conversation_id: 'cursor-chat', workspace_roots: ['/work/api'], prompt: 'Add login' });
  const antigravityBody = JSON.stringify({
    conversationId: 'agy-chat', workspacePaths: ['/work/api'], toolCall: { name: 'ask_question', args: { questions: [{ question: 'Which database?' }] } },
  });
  try {
    expect((await call(port, { method: 'POST', path: '/api/hooks/cursor', body: cursorBody })).status).toBe(401);
    const sink = () => new Writable({ write(_chunk, _enc, cb) { cb(); } });
    await forwardCursorHook(Readable.from([cursorBody]), { HOPPER_HQ_HOME: dataDir }, sink());
    await forwardAntigravityHook(Readable.from([antigravityBody]), { HOPPER_HQ_HOME: dataDir }, 'PreToolUse', sink());
    await collector.idle();
    expect(collector.session('cursor-cursor-chat')).toMatchObject({ agentKind: 'cursor', state: 'working', lastPrompt: 'Add login' });
    expect(collector.session('antigravity-agy-chat')).toMatchObject({ agentKind: 'antigravity', state: 'needs_you' });
    expect((await call(port, { method: 'POST', path: '/api/hooks/antigravity', headers: bearer('test-token'), body: '{' })).status).toBe(400);
  } finally {
    await close(server);
    await collector.close();
  }
});
