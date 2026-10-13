import { contentText } from '@earendil-works/pi-ai';
import type { FileEntry } from '@earendil-works/pi-coding-agent';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface Prompt {
  text: string;
  cwd: string;
  timestamp: number;
}

function getPrompt(entry: FileEntry, cwd: string): Prompt | undefined {
  if (
    entry.type !== 'message' ||
    entry.message.role !== 'user' ||
    !Number.isFinite(entry.message.timestamp)
  ) {
    return;
  }

  const text = contentText(entry.message.content);

  if (!text.trim()) {
    return;
  }

  return { text, cwd, timestamp: entry.message.timestamp };
}

export function extractPrompts(
  entries: Iterable<FileEntry>,
  cwd = '',
  parentSession?: string
): Prompt[] {
  const prompts: Prompt[] = [];

  for (const entry of entries) {
    try {
      if (entry.type === 'session' && typeof entry.cwd === 'string') {
        cwd = entry.cwd;
        parentSession = entry.parentSession;
      }

      if (
        entry.type === 'session_info' &&
        parentSession &&
        /#[0-9a-f]{8}$/i.test(entry.name ?? '')
      ) {
        return [];
      }

      const prompt = getPrompt(entry, cwd);

      if (prompt) {
        prompts.push(prompt);
      }
    } catch {
      continue;
    }
  }

  return prompts;
}

function* parseEntries(content: Uint8Array): Generator<FileEntry> {
  const decoder = new TextDecoder('utf-8', { fatal: true });

  let offset = 0;

  while (offset < content.length) {
    const newline = content.indexOf(0x0a, offset);
    const end = newline === -1 ? content.length : newline;
    const line = content.subarray(offset, end);

    offset = end + 1;

    try {
      yield JSON.parse(decoder.decode(line)) as FileEntry;
    } catch {
      continue;
    }
  }
}

export function parseSession(content: Uint8Array): Prompt[] {
  return extractPrompts(parseEntries(content));
}

export function uniquePrompts(prompts: Prompt[]): Prompt[] {
  const unique = new Map<string, Prompt>();

  for (const prompt of prompts) {
    const previous = unique.get(prompt.text);

    if (!previous || prompt.timestamp > previous.timestamp) {
      unique.set(prompt.text, prompt);
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
  private cache = new Map<
    string,
    { mtime: number; size: number; prompts: Prompt[] }
  >();

  async load(root: string, currentDir: string, signal: AbortSignal) {
    signal.throwIfAborted();

    const directories = new Set([root, currentDir]);
    const files = new Set<string>();

    let skipped = 0;

    for (const directory of directories) {
      signal.throwIfAborted();

      try {
        for (const entry of await readDirectory(directory)) {
          const path = join(directory, entry.name);

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
          cached && cached.mtime === info.mtimeMs && cached.size === info.size
            ? cached
            : {
                mtime: info.mtimeMs,
                size: info.size,
                prompts: parseSession(await readFile(file, { signal })),
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
