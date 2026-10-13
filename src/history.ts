import { contentText } from '@earendil-works/pi-ai';
import type { FileEntry } from '@earendil-works/pi-coding-agent';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface PromptOccurrence {
  text: string;
  cwd: string;
  timestamp: number;
  sessionId: string | undefined;
  sessionFile: string | undefined;
  entryId: string | undefined;
}

export interface PromptGroup {
  text: string;
  cwd: string;
  timestamp: number;
  occurrences: PromptOccurrence[];
}

export function extractPrompts(
  entries: Iterable<FileEntry>,
  {
    cwd = '',
    sessionId,
    sessionFile,
  }: {
    cwd?: string;
    sessionId?: string | undefined;
    sessionFile?: string | undefined;
  } = {}
): PromptOccurrence[] {
  const prompts: PromptOccurrence[] = [];

  for (const entry of entries) {
    if (entry.type === 'session') {
      if (typeof entry.cwd === 'string') {
        cwd = entry.cwd;
      }

      sessionId = typeof entry.id === 'string' ? entry.id : undefined;
      continue;
    }

    if (
      entry.type !== 'message' ||
      entry.message.role !== 'user' ||
      !Number.isFinite(entry.message.timestamp)
    ) {
      continue;
    }

    const text = contentText(entry.message.content);

    if (!text.trim()) {
      continue;
    }

    prompts.push({
      text,
      cwd,
      timestamp: entry.message.timestamp,
      sessionId,
      sessionFile,
      entryId: typeof entry.id === 'string' ? entry.id : undefined,
    });
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
      const entry = JSON.parse(decoder.decode(line)) as FileEntry;

      if (
        entry.type === 'message' &&
        (entry.message.role !== 'user' ||
          !Number.isFinite(entry.message.timestamp) ||
          (typeof entry.message.content !== 'string' &&
            !entry.message.content.every(
              (block) => block.type !== 'text' || typeof block.text === 'string'
            )))
      ) {
        continue;
      }

      yield entry;
    } catch {
      continue;
    }
  }
}

function parseSession(
  content: Uint8Array,
  sessionFile: string
): PromptOccurrence[] {
  return extractPrompts(parseEntries(content), { sessionFile });
}

export function uniquePrompts(prompts: PromptOccurrence[]): PromptGroup[] {
  const unique = new Map<string, PromptGroup>();

  for (const prompt of prompts) {
    const key = JSON.stringify([prompt.text, prompt.cwd]);

    const previous = unique.get(key);

    if (previous) {
      previous.occurrences.push(prompt);
      previous.timestamp = Math.max(previous.timestamp, prompt.timestamp);
    } else {
      unique.set(key, {
        text: prompt.text,
        cwd: prompt.cwd,
        timestamp: prompt.timestamp,
        occurrences: [prompt],
      });
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
    { mtime: number; size: number; prompts: PromptOccurrence[] }
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

    const prompts: PromptOccurrence[] = [];

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
                prompts: parseSession(await readFile(file, { signal }), file),
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
