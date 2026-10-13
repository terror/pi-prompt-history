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

export default function (pi: ExtensionAPI) {
  const store = new HistoryStore();

  let open = false;

  async function showHistory(ctx: ExtensionContext, query: string) {
    if (ctx.mode !== 'tui') {
      ctx.ui.notify('Prompt history requires interactive mode', 'error');
      return;
    }

    if (open) {
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

        loader.onAbort = () => done(undefined);

        store
          .load(
            join(getAgentDir(), 'sessions'),
            ctx.sessionManager.getSessionDir(),
            ctx.sessionManager.getSessionFile(),
            loader.signal
          )
          .then((result) => {
            if (!loader.signal.aborted) {
              done(result);
            }
          })
          .catch((error: unknown) => {
            if (!loader.signal.aborted) {
              done(error instanceof Error ? error : new Error(String(error)));
            }
          });

        return loader;
      });

      if (!history) {
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
        ctx.sessionManager.getCwd()
      );

      const prompts = uniquePrompts([...current, ...history.prompts]);

      if (!prompts.length) {
        ctx.ui.notify('No prompt history found', 'info');
        return;
      }

      await ctx.ui.custom<undefined>(
        (tui, theme, keybindings, done) =>
          new HistoryPicker(
            tui,
            theme,
            keybindings,
            prompts,
            query,
            (selected) => {
              done(undefined);

              if (selected !== undefined) {
                ctx.ui.setEditorText(selected);
                tui.requestRender();
              }
            }
          )
      );
    } catch (error) {
      ctx.ui.notify(
        `Could not load prompt history: ${error instanceof Error ? error.message : String(error)}`,
        'error'
      );
    } finally {
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
