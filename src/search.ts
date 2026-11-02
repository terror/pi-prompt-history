import type { Prompt } from './history.ts';

function match(query: string, text: string): number | undefined {
  if (query.length > text.length) {
    return undefined;
  }

  let score = 0;

  let previous = -1;

  let consecutive = 0;

  for (let index = 0; index < query.length; index++) {
    const position = text.indexOf(query.charAt(index), previous + 1);

    if (position === -1) {
      return undefined;
    }

    if (previous === position - 1) {
      consecutive++;
      score -= consecutive * 5;
    } else {
      consecutive = 0;

      if (previous >= 0) {
        score += (position - previous - 1) * 2;
      }
    }

    if (position === 0 || /[\s\-_./:]/.test(text.charAt(position - 1))) {
      score -= 10;
    }

    score += position * 0.1;
    previous = position;
  }

  return query === text ? score - 100 : score;
}

export function searchPrompts(
  prompts: Prompt[],
  query: string,
  cache: Map<Prompt, string>
): Prompt[] {
  const tokens = query
    .trim()
    .split(/[\s/]+/)
    .filter((token) => token.length > 0)
    .map((token) => {
      const text = token.toLowerCase();

      const parts =
        /^([a-z]+)([0-9]+)$/.exec(text) ?? /^([0-9]+)([a-z]+)$/.exec(text);

      return {
        text,
        swapped: parts ? `${parts[2] ?? ''}${parts[1] ?? ''}` : undefined,
      };
    });

  if (!tokens.length) {
    return prompts;
  }

  function score(text: string): number | undefined {
    let total = 0;

    for (const token of tokens) {
      const primary = match(token.text, text);

      const fallback =
        primary === undefined && token.swapped !== undefined
          ? match(token.swapped, text)
          : undefined;

      const value =
        primary ?? (fallback === undefined ? undefined : fallback + 5);

      if (value === undefined) {
        return undefined;
      }

      total += value;
    }

    return total;
  }

  const matches: { prompt: Prompt; score: number }[] = [];

  for (const prompt of prompts) {
    const text =
      cache.get(prompt) ?? `${prompt.text}\n${prompt.cwd}`.toLowerCase();

    cache.set(prompt, text);

    const value = score(text);

    if (value !== undefined) {
      matches.push({ prompt, score: value });
    }
  }

  return matches.sort((a, b) => a.score - b.score).map(({ prompt }) => prompt);
}
