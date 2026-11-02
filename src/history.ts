import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface Prompt {
  text: string;
  cwd: string;
  timestamp: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function promptText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  const text: string[] = [];

  for (const block of content as unknown[]) {
    if (!isRecord(block)) {
      return '';
    }

    if (block.type === 'text') {
      if (typeof block.text !== 'string') {
        return '';
      }

      text.push(block.text);
    }
  }

  return text.join('\n');
}

class PromptCollector {
  readonly prompts: Prompt[] = [];

  constructor(private cwd = '') {}

  add(entry: unknown) {
    if (!isRecord(entry)) {
      return;
    }

    if (entry.type === 'session') {
      if (typeof entry.cwd === 'string') {
        this.cwd = entry.cwd;
      }

      return;
    }

    const message = entry.message;

    if (
      entry.type !== 'message' ||
      !isRecord(message) ||
      message.role !== 'user' ||
      typeof message.timestamp !== 'number' ||
      !Number.isFinite(message.timestamp)
    ) {
      return;
    }

    const text = promptText(message.content);

    if (!text.trim()) {
      return;
    }

    this.prompts.push({
      text,
      cwd: this.cwd,
      timestamp: message.timestamp,
    });
  }
}

export function extractPrompts(entries: Iterable<unknown>, cwd = ''): Prompt[] {
  const collector = new PromptCollector(cwd);

  for (const entry of entries) {
    collector.add(entry);
  }

  return collector.prompts;
}

async function readPrompts(path: string, size: number, signal: AbortSignal) {
  const collector = new PromptCollector();

  const decoder = new TextDecoder('utf-8', { fatal: true });

  function parse(content: Uint8Array): unknown {
    try {
      return JSON.parse(decoder.decode(content)) as unknown;
    } catch {
      return undefined;
    }
  }

  const file = await open(path, 'r');

  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);

    const fragments: Uint8Array[] = [];

    let position = 0;

    while (position < size) {
      signal.throwIfAborted();

      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, size - position),
        position
      );

      signal.throwIfAborted();

      if (!bytesRead) {
        break;
      }

      position += bytesRead;

      const content = buffer.subarray(0, bytesRead);

      let offset = 0;

      while (offset < content.length) {
        signal.throwIfAborted();

        const newline = content.indexOf(0x0a, offset);

        if (newline === -1) {
          fragments.push(Buffer.from(content.subarray(offset)));

          break;
        }

        const fragment = content.subarray(offset, newline);

        const line = fragments.length
          ? Buffer.concat([...fragments, fragment])
          : fragment;

        fragments.length = 0;
        offset = newline + 1;

        collector.add(parse(line));
      }
    }

    signal.throwIfAborted();

    if (fragments.length) {
      collector.add(parse(Buffer.concat(fragments)));
    }
  } finally {
    await file.close();
  }

  return collector.prompts;
}

export function uniquePrompts(prompts: Prompt[]): Prompt[] {
  const projects = new Map<string, Map<string, Prompt>>();

  const unique: Prompt[] = [];

  for (const prompt of prompts) {
    const project = projects.get(prompt.cwd) ?? new Map<string, Prompt>();

    projects.set(prompt.cwd, project);

    const previous = project.get(prompt.text);

    if (previous) {
      previous.timestamp = Math.max(previous.timestamp, prompt.timestamp);
    } else {
      const entry = { ...prompt };

      project.set(prompt.text, entry);
      unique.push(entry);
    }
  }

  return unique.sort((a, b) => b.timestamp - a.timestamp);
}

async function readDirectory(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

async function mapConcurrent<T, U>(
  values: T[],
  signal: AbortSignal,
  fn: (value: T) => Promise<U>
): Promise<U[]> {
  const entries = values.entries();

  const results = new Array<U>(values.length);

  const workers = Array.from(
    { length: Math.min(8, values.length) },
    async () => {
      for (const [index, value] of entries) {
        signal.throwIfAborted();
        results[index] = await fn(value);
        signal.throwIfAborted();
      }
    }
  );

  const settled = await Promise.allSettled(workers);

  const failed = settled.find((result) => result.status === 'rejected');

  if (failed) {
    throw failed.reason;
  }

  return results;
}

export class HistoryStore {
  private readonly cache = new Map<
    string,
    { mtime: number; size: number; prompts: Prompt[] }
  >();

  async load(
    root: string,
    currentDir: string,
    currentFile: string | undefined,
    signal: AbortSignal
  ) {
    signal.throwIfAborted();

    const directories = new Set([root, currentDir]);

    const files = new Set<string>();

    let skipped = 0;

    let pending = [...directories];

    while (pending.length) {
      const next: string[] = [];

      const results = await mapConcurrent(
        pending,
        signal,
        async (directory) => {
          try {
            return { directory, entries: await readDirectory(directory) };
          } catch {
            skipped++;

            return { directory, entries: [] };
          }
        }
      );

      for (const { directory, entries } of results) {
        for (const entry of entries) {
          const path = join(directory, entry.name);

          if (path === currentFile) {
            continue;
          }

          if (
            entry.name.endsWith('.jsonl') &&
            (entry.isFile() || entry.isSymbolicLink())
          ) {
            files.add(path);
          } else if (
            directory === root &&
            (entry.isDirectory() || entry.isSymbolicLink()) &&
            !directories.has(path)
          ) {
            directories.add(path);
            next.push(path);
          }
        }
      }

      pending = next;
    }

    const prompts = await mapConcurrent([...files], signal, async (file) => {
      try {
        const info = await stat(file);

        signal.throwIfAborted();

        if (!info.isFile()) {
          throw new Error('Not a regular session file');
        }

        const cached = this.cache.get(file);

        const entry =
          cached?.mtime === info.mtimeMs && cached.size === info.size
            ? cached
            : {
                mtime: info.mtimeMs,
                size: info.size,
                prompts: await readPrompts(file, info.size, signal),
              };

        signal.throwIfAborted();

        this.cache.set(file, entry);

        return entry.prompts;
      } catch {
        signal.throwIfAborted();
        this.cache.delete(file);
        skipped++;

        return [];
      }
    });

    for (const file of this.cache.keys()) {
      if (!files.has(file)) {
        this.cache.delete(file);
      }
    }

    signal.throwIfAborted();

    return { prompts: prompts.flat(), skipped };
  }
}
