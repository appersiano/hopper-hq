import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { RawEvent } from '../../core/types.js';
import type { WorkspaceResolver } from '../git.js';
import { readNewLines, type TailState } from '../claude-code/jsonl.js';
import { isSessionId } from '../../scene/text.js';
import { cursorSessionId, parseCursorLine } from './transcript.js';
import { decodeCursorProject } from './project-path.js';

interface Tracked {
  sessionId: string;
  cwd: string;
  tail: TailState;
  grew: number;
  polled: number;
  replayed: boolean;
  mtime: number;
}

const QUIET_AFTER_MS = 10 * 60_000;
const QUIET_POLL_MS = 15_000;
const WEEK_MS = 7 * 86400_000;

export interface CursorAdapterOptions {
  cursorDir: string;
  emit: (event: RawEvent) => void;
  resolveWorkspace: WorkspaceResolver;
  ignoreCwd?: (cwd: string) => boolean;
  now?: () => number;
  log?: (line: string) => void;
}

/** Read-only discovery of Cursor agent transcripts. Nothing under `~/.cursor` is written. */
export class CursorAdapter {
  readonly agentKind = 'cursor' as const;
  skipped = 0;
  private readonly tracked = new Map<string, Tracked>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private lastDiscovery: number | null = null;

  constructor(private readonly o: CursorAdapterOptions) {}

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
        await this.scanProjects(join(this.o.cursorDir, 'projects'));
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
      this.o.log?.(`Cursor scan unavailable: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy = false;
    }
  }

  private async scanProjects(root: string): Promise<void> {
    let projects;
    try {
      projects = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const transcripts = join(root, project.name, 'agent-transcripts');
      let sessions;
      try {
        sessions = await readdir(transcripts, { withFileTypes: true });
      } catch {
        continue;
      }
      const cwd = await decodeCursorProject(project.name);
      if (!cwd || this.o.ignoreCwd?.(cwd)) continue;
      for (const session of sessions) {
        if (!session.isDirectory()) continue;
        const path = join(transcripts, session.name, `${session.name}.jsonl`);
        if (this.tracked.has(path) || !isSessionId(cursorSessionId(session.name))) continue;
        try {
          const modified = (await stat(path)).mtimeMs;
          if (modified < (this.o.now ?? Date.now)() - WEEK_MS) continue;
          await this.follow(path, cwd);
        } catch {
          /* A missing transcript cannot stop the other sessions. */
        }
      }
    }
  }

  private async follow(path: string, cwd?: string): Promise<void> {
    const now = (this.o.now ?? Date.now)();
    let tracked = this.tracked.get(path);
    if (!tracked) {
      if (!cwd) return;
      const file = await stat(path);
      const sessionId = cursorSessionId(basename(path, '.jsonl'));
      tracked = { sessionId, cwd, tail: { path, offset: 0, skipping: false }, grew: file.mtimeMs, polled: now, replayed: false, mtime: file.mtimeMs };
      this.tracked.set(path, tracked);
      this.o.emit({
        type: 'session.seen',
        agentKind: 'cursor',
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
    const ts = tracked.replayed ? now : tracked.mtime;
    if (next.lines.length > 0) tracked.grew = ts;
    tracked.replayed = true;
    for (const line of next.lines) {
      const parsed = parseCursorLine(line, { sessionId: tracked.sessionId, cwd: tracked.cwd, ts });
      this.skipped += parsed.skipped;
      for (const event of parsed.events) this.o.emit(event);
    }
  }
}
