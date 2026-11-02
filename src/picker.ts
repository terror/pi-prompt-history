import {
  DynamicBorder,
  type KeybindingsManager,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import {
  type Component,
  type Focusable,
  Input,
  Key,
  type TUI,
  fuzzyFilter,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import { basename } from 'node:path';

import type { Prompt } from './history.ts';

function displayText(text: string): string {
  return stripTerminalSequences(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

function previewLines(text: string, width: number, rows: number): string[] {
  let length = Math.min(text.length, width * (rows + 1));

  for (;;) {
    const lines = wrapTextWithAnsi(text.slice(0, length), width);

    if (length === text.length || lines.length > rows) {
      return lines.slice(0, rows + 1);
    }

    length = Math.min(text.length, length * 2);
  }
}

export class HistoryPicker implements Component, Focusable {
  private readonly border: DynamicBorder;

  /** Search field that receives focus and query input. */
  private readonly input: Input;

  /** Display labels cached as prompts enter the visible list. */
  private readonly labels = new Map<Prompt, string>();

  /** Prompt text and project paths combined and cached on the first search. */
  private readonly searchText = new Map<Prompt, string>();

  /** Prompts matching the current query, in display order. */
  private matches: Prompt[] = [];

  /** Index of the highlighted prompt within the current matches. */
  private selectedIndex = 0;

  /** Number of list rows that fit in the current terminal layout. */
  private maxVisible = 10;

  /** Preview cached for the selected prompt, terminal width, and row limit. */
  private preview:
    | {
        prompt: Prompt;
        width: number;
        rows: number;
        cwd: string;
        lines: string[];
      }
    | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly prompts: Prompt[],
    query: string,
    private readonly done: (value: string | undefined) => void
  ) {
    this.border = new DynamicBorder((text) => theme.fg('border', text));

    this.input = new Input();

    this.pasteQuery(query);

    this.filter();
  }

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  private pasteQuery(text: string) {
    this.input.handleInput(
      `\x1b[200~${displayText(text).replace(/\s+/g, ' ')}\x1b[201~`
    );
  }

  private filter() {
    this.matches = fuzzyFilter(
      this.prompts,
      this.input.getValue(),
      (prompt) => {
        const text =
          this.searchText.get(prompt) ?? `${prompt.text}\n${prompt.cwd}`;

        this.searchText.set(prompt, text);

        return text;
      }
    );

    this.selectedIndex = 0;
  }

  handleInput(data: string) {
    const kb = this.keybindings;

    const index = this.selectedIndex;

    const count = this.matches.length;

    if (kb.matches(data, 'tui.select.cancel')) {
      this.done(undefined);
    } else if (kb.matches(data, 'tui.select.confirm')) {
      const selected = this.matches[index];

      if (selected) {
        this.done(selected.text);
      }
    } else if (kb.matches(data, 'tui.select.up')) {
      this.selectedIndex = count ? (index + count - 1) % count : 0;
    } else if (
      kb.matches(data, 'tui.select.down') ||
      matchesKey(data, Key.ctrl('r'))
    ) {
      this.selectedIndex = count ? (index + 1) % count : 0;
    } else if (kb.matches(data, 'tui.select.pageUp')) {
      this.selectedIndex = Math.max(0, index - this.maxVisible);
    } else if (kb.matches(data, 'tui.select.pageDown')) {
      this.selectedIndex = Math.max(
        0,
        Math.min(count - 1, index + this.maxVisible)
      );
    } else {
      const query = this.input.getValue();

      if (data.startsWith('\x1b[200~') && data.endsWith('\x1b[201~')) {
        this.pasteQuery(data.slice(6, -6));
      } else {
        this.input.handleInput(data);
      }

      if (this.input.getValue() !== query) {
        this.filter();
      }
    }

    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width < 1) {
      return [];
    }

    const rows = Math.max(6, this.tui.terminal.rows - 4);

    const compact = rows < 16;

    const keys = (action: Parameters<KeybindingsManager['getKeys']>[0]) =>
      this.keybindings
        .getKeys(action)
        .map((key) =>
          key
            .split('+')
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join('+')
        )
        .join('/');

    const footer = [
      ...(compact ? [] : ['']),
      this.theme.fg(
        'dim',
        `  ${keys('tui.select.confirm')} to insert · Ctrl+R next · ${keys('tui.select.cancel')} to cancel`
      ),
      ...this.border.render(width),
    ];

    const lines = [
      ...this.border.render(width),
      ...(compact ? [] : ['']),
      this.theme.fg(
        'muted',
        `Prompt history · ${String(this.matches.length)}/${String(this.prompts.length)}`
      ),
      ...(compact
        ? []
        : [this.theme.fg('dim', 'Search prompts or project paths'), '']),
      ...this.input.render(width),
      ...(compact ? [] : ['']),
    ];

    const available = rows - lines.length - footer.length;

    this.maxVisible = Math.max(1, Math.min(10, Math.floor(available / 2)));

    const start = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.maxVisible / 2),
        this.matches.length - this.maxVisible
      )
    );

    for (const [offset, prompt] of this.matches
      .slice(start, start + this.maxVisible)
      .entries()) {
      const selected = start + offset === this.selectedIndex;

      const label =
        this.labels.get(prompt) ??
        displayText(prompt.text).replace(/\s+/g, ' ').slice(0, 200);

      this.labels.set(prompt, label);

      const project = displayText(basename(prompt.cwd) || prompt.cwd).replace(
        /\n/g,
        ' '
      );

      const badge = truncateToWidth(
        project ? ` [${project}]` : '',
        Math.floor(Math.max(0, width - 6) / 2),
        '…'
      );

      const text = truncateToWidth(
        label,
        Math.max(0, width - 4 - visibleWidth(badge)),
        '…'
      );

      const cursor = selected ? this.theme.fg('accent', '→ ') : '  ';

      lines.push(
        `${cursor}  ${selected ? this.theme.fg('accent', text) : text}${this.theme.fg('muted', badge)}`
      );
    }

    if (!this.matches.length) {
      lines.push(this.theme.fg('muted', '  No matching prompts'));
    } else if (this.matches.length > this.maxVisible && available > 1) {
      lines.push(
        this.theme.fg(
          'muted',
          truncateToWidth(
            `  (${String(this.selectedIndex + 1)}/${String(this.matches.length)})`,
            Math.max(0, width - 2),
            ''
          )
        )
      );
    }

    const selected = this.matches[this.selectedIndex];

    const previewRows = Math.min(6, rows - lines.length - footer.length - 2);

    if (selected && previewRows > 0) {
      if (
        this.preview?.prompt !== selected ||
        this.preview.width !== width ||
        this.preview.rows !== previewRows
      ) {
        this.preview = {
          prompt: selected,
          width,
          rows: previewRows,
          cwd: displayText(selected.cwd).replace(/\n/g, ' '),
          lines: previewLines(
            displayText(selected.text),
            Math.max(1, width - 2),
            previewRows
          ),
        };
      }

      const date = new Date(selected.timestamp).toLocaleString();

      lines.push('', this.theme.fg('muted', `  ${date} · ${this.preview.cwd}`));

      const preview = this.preview.lines;

      lines.push(...preview.slice(0, previewRows).map((line) => `  ${line}`));

      if (preview.length > previewRows) {
        lines[lines.length - 1] = this.theme.fg('dim', '  …');
      }
    }

    lines.push(...footer);

    return lines.map((line) => truncateToWidth(line, width));
  }

  invalidate() {
    this.input.invalidate();
  }
}
