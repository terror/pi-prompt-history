import type {
  KeybindingsManager,
  Theme,
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
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';

import type { Prompt } from './history.ts';

function displayText(text: string): string {
  return stripTerminalSequences(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

interface DisplayPrompt extends Prompt {
  label: string;
  searchText: string;
  displayText: string;
  displayCwd: string;
}

export class HistoryPicker implements Component, Focusable {
  private readonly input: Input;
  private readonly prompts: DisplayPrompt[];
  private matches: DisplayPrompt[] = [];
  private selectedIndex = 0;
  private maxVisible = 8;
  private preview:
    { prompt: DisplayPrompt; width: number; lines: string[] } | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    prompts: Prompt[],
    query: string,
    private readonly done: (value: string | undefined) => void
  ) {
    this.prompts = prompts.map((prompt) => {
      const text = displayText(prompt.text);

      return {
        ...prompt,
        label: text.replace(/\s+/g, ' ').slice(0, 200),
        searchText: `${prompt.text}\n${prompt.cwd}`,
        displayText: text,
        displayCwd: displayText(prompt.cwd).replace(/\n/g, ' '),
      };
    });

    this.input = new Input({
      placeholder: 'Search prompts or project paths…',
      placeholderStyle: (text) => theme.fg('dim', text),
    });

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
      (prompt) => prompt.searchText
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

    const rows = Math.max(1, Math.floor(this.tui.terminal.rows / 2));
    this.maxVisible = Math.max(1, Math.min(8, Math.floor((rows - 6) / 2)));

    const start = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.maxVisible / 2),
        this.matches.length - this.maxVisible
      )
    );

    const lines = [
      this.theme.fg(
        'accent',
        this.theme.bold(
          `Prompt history · ${String(this.matches.length)}/${String(this.prompts.length)}`
        )
      ),
      ...this.input.render(width),
    ];

    for (const [offset, prompt] of this.matches
      .slice(start, start + this.maxVisible)
      .entries()) {
      const selected = start + offset === this.selectedIndex;
      const label = truncateToWidth(prompt.label, Math.max(0, width - 4), '');
      const line = `${selected ? '→ ' : '  '}${label}`;

      lines.push(selected ? this.theme.fg('accent', line) : line);
    }

    if (!this.matches.length) {
      lines.push(this.theme.fg('warning', 'No matching prompts'));
    } else if (this.matches.length > this.maxVisible) {
      lines.push(
        this.theme.fg(
          'dim',
          truncateToWidth(
            `  (${String(this.selectedIndex + 1)}/${String(this.matches.length)})`,
            Math.max(0, width - 2),
            ''
          )
        )
      );
    }

    const selected = this.matches[this.selectedIndex];
    const previewRows = Math.min(6, rows - lines.length - 4);

    if (selected && previewRows > 0) {
      const date = new Date(selected.timestamp).toLocaleString();

      lines.push(
        '',
        this.theme.fg('muted', `${date} · ${selected.displayCwd}`)
      );

      if (this.preview?.prompt !== selected || this.preview.width !== width) {
        this.preview = {
          prompt: selected,
          width,
          lines: wrapTextWithAnsi(selected.displayText, width),
        };
      }

      const preview = this.preview.lines;

      lines.push(...preview.slice(0, previewRows));

      if (preview.length > previewRows) {
        lines[lines.length - 1] = this.theme.fg('dim', '…');
      }
    }

    const keys = (action: Parameters<KeybindingsManager['getKeys']>[0]) =>
      this.keybindings.getKeys(action).join('/');

    lines.push(
      this.theme.fg(
        'dim',
        `${keys('tui.select.up')}/${keys('tui.select.down')} navigate · ctrl+r next · ${keys('tui.select.confirm')} insert · ${keys('tui.select.cancel')} cancel`
      )
    );

    return lines.map((line) => truncateToWidth(line, width));
  }

  invalidate() {
    this.input.invalidate();
  }
}
