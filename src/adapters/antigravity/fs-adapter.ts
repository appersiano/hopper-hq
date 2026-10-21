import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RawEvent } from '../../core/types.js';
import { isSessionId } from '../../scene/text.js';
import type { WorkspaceResolver } from '../git.js';
import { readNewLines, type TailState } from '../claude-code/jsonl.js';
import { object, string } from '../payload.js';
import { antigravitySessionId, parseAntigravityLine } from './transcript.js';

interface Tracked {
  sessionId: string;
  cwd: string;
  tail: TailState;
  grew: number;
  polled: number;
}

const ROOTS = ['antigravity-cli', 'antigravity', 'antigravity-ide'] as const;
const QUIET_AFTER_MS = 10 * 60_000;
const QUIET_POLL_MS = 15_000;
const WEEK_MS = 7 * 86400_000;

export interface AntigravityAdapterOptions {
  /** Gemini config root, usually `~/.gemini`. Transcripts live under its Antigravity brain directories. */
  geminiDir: string;
  emit: (event: RawEvent) => void;
  resolveWorkspace: WorkspaceResolver;
  ignoreCwd?: (cwd: string) => boolean;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * Read-only discovery of Antigravity transcripts. The same conversation id is followed once, CLI before app before IDE.
 * Compaction can rewrite a transcript; a shrink is read again from the start by the shared tail reader.
 */
export class AntigravityAdapter {
  readonly agentKind = 'antigravity' as const;
  skipped = 0;
  private readonly tracked = new Map<string, Tracked>();
  private readonly seen = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private lastDiscovery: number | null = null;
  private workspaces = new Map<string, string>();

  constructor(private readonly o: AntigravityAdapterOptions) {}

  start(intervalMs = 1000): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = (this.o.now ?? Date.now)();
      if (this.lastDiscovery === null || now - this.lastDiscovery >= 10_000) {
        this.lastDiscovery = now;
        await this.loadWorkspaces();
        for (const root of ROOTS) await this.scanBrain(join(this.o.geminiDir, root, 'brain'));
      }
      for (const [path, tracked] of [...this.tracked]) {
        if (now - tracked.grew >= QUIET_AFTER_MS && now - tracked.polled < QUIET_POLL_MS) continue;
        tracked.polled = now;
        try {
          await this.follow(path);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') this.tracked.delete(path);
        }
      }
    } catch (err) {
      this.o.log?.(`Antigravity scan unavailable: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy = false;
    }
  }

  private async loadWorkspaces(): Promise<void> {
    for (const root of ROOTS) {
      try {
        const parsed = object(JSON.parse(await readFile(join(this.o.geminiDir, root, 'cache', 'last_conversations.json'), 'utf8')));
        for (const [workspace, id] of Object.entries(parsed)) {
          const conversation = string(id);
          if (conversation && workspace.startsWith('/') && !this.workspaces.has(conversation)) this.workspaces.set(conversation, workspace);
        }
      } catch {
        /* The cache is optional. A conversation with no workspace is skipped until a transcript line names one. */
      }
    }
  }

  private async scanBrain(brain: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(brain, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionId = antigravitySessionId(entry.name);
      if (!isSessionId(sessionId) || this.seen.has(sessionId)) continue;
      const logs = join(brain, entry.name, '.system_generated', 'logs');
      const full = join(logs, 'transcript_full.jsonl');
      const compact = join(logs, 'transcript.jsonl');
      const path = await existing(full) ?? (await existing(compact));
      if (!path) continue;
      try {
        if ((await stat(path)).mtimeMs < (this.o.now ?? Date.now)() - WEEK_MS) continue;
      } catch {
        continue;
      }
      const cwd = this.workspaces.get(entry.name);
      if (!cwd || this.o.ignoreCwd?.(cwd)) continue;
      this.seen.add(sessionId);
      await this.follow(path, sessionId, cwd);
    }
  }

  private async follow(path: string, sessionId?: string, cwd?: string): Promise<void> {
    const now = (this.o.now ?? Date.now)();
    let tracked = this.tracked.get(path);
    if (!tracked) {
      if (!sessionId || !cwd) return;
      const file = await stat(path);
      tracked = { sessionId, cwd, tail: { path, offset: 0, skipping: false }, grew: file.mtimeMs, polled: now };
      this.tracked.set(path, tracked);
      this.o.emit({
        type: 'session.seen',
        agentKind: 'antigravity',
        sessionId,
        ts: file.birthtimeMs > 0 ? file.birthtimeMs : file.mtimeMs,
        source: 'fs',
        cwd,
        workspace: await this.o.resolveWorkspace(cwd),
        transcriptPath: path,
        startedAt: file.birthtimeMs > 0 ? file.birthtimeMs : file.mtimeMs,
      });
    }
    const next = await readNewLines(tracked.tail);
    if (next.state.skipping && !tracked.tail.skipping) this.skipped++;
    tracked.tail = next.state;
    if (next.lines.length > 0) tracked.grew = now;
    for (const line of next.lines) {
      const parsed = parseAntigravityLine(line, { sessionId: tracked.sessionId, cwd: tracked.cwd });
      this.skipped += parsed.skipped;
      if (parsed.cwd && parsed.cwd !== tracked.cwd && !this.o.ignoreCwd?.(parsed.cwd)) {
        tracked.cwd = parsed.cwd;
        this.o.emit({
          type: 'session.seen',
          agentKind: 'antigravity',
          sessionId: tracked.sessionId,
          ts: now,
          source: 'fs',
          cwd: parsed.cwd,
          workspace: await this.o.resolveWorkspace(parsed.cwd),
          transcriptPath: path,
        });
      }
      if (!this.o.ignoreCwd?.(tracked.cwd)) for (const event of parsed.events) this.o.emit(event);
    }
  }
}

async function existing(path: string): Promise<string | null> {
  try {
    await stat(path);
    return path;
  } catch {
    return null;
  }
}
