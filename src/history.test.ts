import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import {
  appendFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { HistoryStore, uniquePrompts } from './history.ts';

let directory: string;

const signal = new AbortController().signal;

const prompt = {
  text: 'foo',
  cwd: 'foo',
  timestamp: 1,
  sessionId: 'foo',
  sessionFile: undefined,
  entryId: 'bar',
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pi-prompt-history-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function message(content: unknown = 'foo', timestamp = 1, role = 'user') {
  return { type: 'message', id: 'bar', message: { role, content, timestamp } };
}

function jsonl(...entries: unknown[]) {
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

async function session(file: string, entries: unknown[] = [message()]) {
  await mkdir(dirname(file), { recursive: true });

  await writeFile(
    file,
    jsonl({ type: 'session', id: 'foo', cwd: 'foo' }, ...entries)
  );
}

function load(store = new HistoryStore()) {
  return store.load(directory, directory, undefined, signal);
}

test.each(['foo/bar', 'baz'])(
  'discovers history with session directory %s',
  async (currentDir) => {
    const root = join(directory, 'foo');

    const currentFile = join(root, 'bar', 'baz.jsonl');

    const files = [
      join(root, 'foo.jsonl'),
      join(root, 'bar', 'foo.jsonl'),
      join(directory, currentDir, 'bar.jsonl'),
    ];

    for (const [timestamp, file] of files.entries()) {
      await session(file, [message('foo', timestamp)]);
    }

    await session(currentFile);
    await session(join(root, 'foo.txt'));
    await session(join(root, 'bar', 'baz', 'foo.jsonl'));

    const result = await new HistoryStore().load(
      root,
      join(directory, currentDir),
      currentFile,
      signal
    );

    result.prompts.sort((a, b) => a.timestamp - b.timestamp);

    expect(result).toStrictEqual({
      prompts: files.map((sessionFile, timestamp) => ({
        ...prompt,
        sessionFile,
        timestamp,
      })),
      skipped: 0,
    });
  }
);

test.each<[unknown, string | undefined]>([
  [' foo\nbar\t ', ' foo\nbar\t '],
  [
    [
      { type: 'text', text: 'foo' },
      { type: 'image' },
      { type: 'text', text: 'bar' },
    ],
    'foo\nbar',
  ],
  [' \n\t', undefined],
  [[{ type: 'image' }], undefined],
])('extracts text from %j', async (content, text) => {
  const file = join(directory, 'foo.jsonl');

  await session(file, [message(content)]);

  expect(await load()).toStrictEqual({
    prompts: text === undefined ? [] : [{ ...prompt, text, sessionFile: file }],
    skipped: 0,
  });
});

test('groups by text and project, preserving occurrences and newest timestamps', () => {
  const foo = { ...prompt, timestamp: 2 };
  const bar = { ...prompt, timestamp: 1 };
  const baz = { ...prompt, timestamp: 3 };
  const qux = { ...prompt, cwd: 'bar', timestamp: 4 };
  const bob = { ...prompt, text: 'bar', timestamp: 5 };

  expect(uniquePrompts([foo, bar, baz, qux, bob])).toStrictEqual([
    { text: 'bar', cwd: 'foo', timestamp: 5, occurrences: [bob] },
    { text: 'foo', cwd: 'bar', timestamp: 4, occurrences: [qux] },
    { text: 'foo', cwd: 'foo', timestamp: 3, occurrences: [foo, bar, baz] },
  ]);
});

test('ignores missing directories and reports unreadable paths', async () => {
  const root = join(directory, 'foo');
  const currentDir = join(directory, 'bar');
  const file = join(root, 'foo.jsonl');

  const store = new HistoryStore();

  expect(await store.load(root, currentDir, undefined, signal)).toStrictEqual({
    prompts: [],
    skipped: 0,
  });

  await session(file);
  await writeFile(currentDir, 'foo');
  await symlink(join(directory, 'baz'), join(root, 'bar.jsonl'));

  expect(await store.load(root, currentDir, undefined, signal)).toStrictEqual({
    prompts: [{ ...prompt, sessionFile: file }],
    skipped: 2,
  });
});

test('propagates cancellation during loading', async () => {
  const controller = new AbortController();

  const error = new Error('foo');

  const result = new HistoryStore().load(
    directory,
    directory,
    undefined,
    controller.signal
  );

  controller.abort(error);

  await rejects(result, error);
});

test('reloads changed files and removes deleted prompts', async () => {
  const file = join(directory, 'foo.jsonl');

  const foo = { ...prompt, sessionFile: file };

  const store = new HistoryStore();

  await session(file);
  await utimes(file, 1, 1);

  expect(await load(store)).toStrictEqual({ prompts: [foo], skipped: 0 });

  await session(file, [message('bar')]);
  await utimes(file, 1, 2);

  expect(await load(store)).toStrictEqual({
    prompts: [{ ...foo, text: 'bar' }],
    skipped: 0,
  });

  await appendFile(file, jsonl(message('baz', 2)));
  await utimes(file, 1, 2);

  expect(await load(store)).toStrictEqual({
    prompts: [
      { ...foo, text: 'bar' },
      { ...foo, text: 'baz', timestamp: 2 },
    ],
    skipped: 0,
  });

  await rm(file);

  expect(await load(store)).toStrictEqual({ prompts: [], skipped: 0 });
});

test.each<[string, string | Uint8Array]>([
  ['invalid JSON', '{'],
  ['invalid UTF-8', Buffer.from(jsonl(message('\xff')), 'latin1')],
  ['invalid timestamps', jsonl(message('foo', NaN))],
  ['non-user messages', jsonl(message('foo', 1, 'assistant'))],
])('skips %s and keeps surrounding prompts', async (_name, invalid) => {
  const file = join(directory, 'foo.jsonl');

  await session(file);

  await appendFile(file, invalid);
  await appendFile(file, `\n${JSON.stringify(message('bar', 2))}`);

  expect(await load()).toStrictEqual({
    prompts: [
      { ...prompt, sessionFile: file },
      { ...prompt, text: 'bar', timestamp: 2, sessionFile: file },
    ],
    skipped: 0,
  });
});
