import { stat } from 'node:fs/promises';

/** Cursor names a project folder by replacing each '/' in the absolute path with '-'. */
export async function decodeCursorProject(slug: string, isDirectory: (path: string) => Promise<boolean> = directoryExists): Promise<string | null> {
  const parts = slug.split('-').filter((part) => part.length > 0);
  if (parts.length === 0 || parts.length > 64) return null;

  async function walk(index: number, dir: string): Promise<string | null> {
    let segment = '';
    for (let end = index + 1; end <= parts.length; end++) {
      segment = segment ? `${segment}-${parts[end - 1]}` : parts[end - 1]!;
      const next = `${dir}/${segment}`;
      if (!(await isDirectory(next))) continue;
      if (end === parts.length) return next;
      const found = await walk(end, next);
      if (found) return found;
    }
    return null;
  }

  return walk(0, '');
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
