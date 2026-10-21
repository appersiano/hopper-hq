import { AGENT_ID } from '../core/reducer.js';

export const object = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export const string = (v: unknown): string => (typeof v === 'string' ? v : '');

export function firstString(v: unknown): string {
  return Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '';
}

export function hopperTs(p: Record<string, unknown>, now: number): number {
  return typeof p._hopper_ts === 'number' && Number.isFinite(p._hopper_ts) ? p._hopper_ts : now;
}

/** An agent id the reducer will keep. Anything else names no intern. */
export function agentId(raw: string): string | null {
  const id = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128);
  return AGENT_ID.test(id) ? id : null;
}
