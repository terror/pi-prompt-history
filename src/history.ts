import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface Prompt {
  text: string;
  cwd: string;
  timestamp: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function promptText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const text: string[] = [];

  for (const block of content as unknown[]) {
    if (!isRecord(block)) {
      return undefined;
    }

    if (block.type === 'text') {
      if (typeof block.text !== 'string') {
        return undefined;
      }

      text.push(block.text);
    }
  }

  return text.join('\n');
}

export function extractPrompts(entries: Iterable<unknown>, cwd = ''): Prompt[] {
  const prompts: Prompt[] = [];

  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }

    if (entry.type === 'session') {
      if (typeof entry.cwd === 'string') {
        cwd = entry.cwd;
      }

      continue;
    }

    const message = entry.message;

    if (
      entry.type !== 'message' ||
      !isRecord(message) ||
      message.role !== 'user' ||
      typeof message.timestamp !== 'number' ||
      !Number.isFinite(message.timestamp)
    ) {
      continue;
    }

    const text = promptText(message.content);

    if (!text?.trim()) {
      continue;
    }

    prompts.push({
      text,
      cwd,
      timestamp: message.timestamp,
    });
  }

  return prompts;
}

function* parseEntries(content: Uint8Array) {
  const decoder = new TextDecoder('utf-8', { fatal: true });

  let offset = 0;

  while (offset < content.length) {
    const newline = content.indexOf(0x0a, offset);
    const end = newline === -1 ? content.length : newline;
    const line = content.subarray(offset, end);

    offset = end + 1;

    try {
      yield JSON.parse(decoder.decode(line)) as unknown;
    } catch {
      continue;
    }
  }
}

export function uniquePrompts(prompts: Prompt[]): Prompt[] {
  const unique = new Map<string, Prompt>();

  for (const prompt of prompts) {
    const key = JSON.stringify([prompt.text, prompt.cwd]);

    const previous = unique.get(key);

    if (previous) {
      previous.timestamp = Math.max(previous.timestamp, prompt.timestamp);
    } else {
      unique.set(key, { ...prompt });
    }
  }

  return [...unique.values()].sort((a, b) => b.timestamp - a.timestamp);
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

    for (const directory of directories) {
      signal.throwIfAborted();

      try {
        for (const entry of await readDirectory(directory)) {
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
            (entry.isDirectory() || entry.isSymbolicLink())
          ) {
            directories.add(path);
          }
        }
      } catch {
        skipped++;
      }
    }

    const prompts: Prompt[] = [];

    for (const file of files) {
      signal.throwIfAborted();

      try {
        const info = await stat(file);

        const cached = this.cache.get(file);

        const entry =
          cached?.mtime === info.mtimeMs && cached.size === info.size
            ? cached
            : {
                mtime: info.mtimeMs,
                size: info.size,
                prompts: extractPrompts(
                  parseEntries(await readFile(file, { signal }))
                ),
              };

        this.cache.set(file, entry);

        for (const prompt of entry.prompts) {
          prompts.push(prompt);
        }
      } catch {
        signal.throwIfAborted();
        this.cache.delete(file);
        skipped++;
      }
    }

    for (const file of this.cache.keys()) {
      if (!files.has(file)) {
        this.cache.delete(file);
      }
    }

    signal.throwIfAborted();

    return { prompts, skipped };
  }
}
