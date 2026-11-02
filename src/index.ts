import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';
import { Key } from '@earendil-works/pi-tui';
import { join } from 'node:path';

import { HistoryStore, extractPrompts, uniquePrompts } from './history.ts';
import { HistoryPicker } from './picker.ts';

const store = new HistoryStore();

const dialogOptions = {
  overlay: true,
  overlayOptions: {
    width: '100%',
    maxHeight: '100%',
    anchor: 'bottom-center',
  },
} as const;

export default function (pi: ExtensionAPI) {
  const lifecycle = new AbortController();

  const isShutdown = () => lifecycle.signal.aborted;

  let open = false;

  let close: (() => void) | undefined;

  pi.on('session_shutdown', () => {
    lifecycle.abort();

    close?.();
  });

  async function showHistory(ctx: ExtensionContext, query: string) {
    if (open || isShutdown()) {
      return;
    }

    if (ctx.mode !== 'tui') {
      ctx.ui.notify('Prompt history requires interactive mode', 'error');

      return;
    }

    open = true;

    try {
      const history = await ctx.ui.custom<
        Awaited<ReturnType<HistoryStore['load']>> | Error | undefined
      >((tui, theme, _keybindings, done) => {
        const loader = new BorderedLoader(
          tui,
          theme,
          'Loading prompt history…'
        );

        const signal = AbortSignal.any([loader.signal, lifecycle.signal]);

        close = () => done(undefined);

        loader.onAbort = close;

        store
          .load(
            join(getAgentDir(), 'sessions'),
            ctx.sessionManager.getSessionDir(),
            ctx.sessionManager.getSessionFile(),
            signal
          )
          .then((result) => {
            if (!signal.aborted) {
              done(result);
            }
          })
          .catch((error: unknown) => {
            if (!signal.aborted) {
              done(error instanceof Error ? error : new Error(String(error)));
            }
          });

        return loader;
      });

      close = undefined;

      if (!history || isShutdown()) {
        return;
      }

      if (history instanceof Error) {
        throw history;
      }

      if (history.skipped) {
        ctx.ui.notify(
          `Prompt history skipped ${String(history.skipped)} unreadable files or directories`,
          'warning'
        );
      }

      const current = extractPrompts(
        ctx.sessionManager.getEntries(),
        ctx.sessionManager.getHeader()?.cwd ?? ''
      );

      const prompts = uniquePrompts([...current, ...history.prompts]);

      if (!prompts.length) {
        ctx.ui.notify('No prompt history found', 'info');

        return;
      }

      await ctx.ui.custom<undefined>((tui, theme, keybindings, done) => {
        close = () => done(undefined);

        return new HistoryPicker(
          tui,
          theme,
          keybindings,
          prompts,
          query,
          (selected) => {
            done(undefined);

            if (selected !== undefined && !isShutdown()) {
              ctx.ui.setEditorText(selected);

              tui.requestRender();
            }
          }
        );
      }, dialogOptions);
    } catch (error) {
      if (!isShutdown()) {
        ctx.ui.notify(
          `Could not load prompt history: ${error instanceof Error ? error.message : String(error)}`,
          'error'
        );
      }
    } finally {
      close = undefined;

      open = false;
    }
  }

  pi.registerCommand('history', {
    description: 'Fuzzy-search prompts across all sessions',
    handler: (args, ctx) => showHistory(ctx, args.trim()),
  });

  pi.registerShortcut(Key.ctrl('r'), {
    description: 'Search global prompt history',
    handler: (ctx) => showHistory(ctx, ctx.ui.getEditorText()),
  });
}
