import type { Key } from "node:readline";

/** What a prompt gives back when esc was pressed instead of an answer. */
export const BACK = Symbol("back");
export type Back = typeof BACK;

/**
 * Ask something, but let esc back out of it. Inquirer has no idea about esc, so
 * we watch the keys ourselves while the prompt is up and cancel it when it's hit.
 *
 * Pass the context straight through to the prompt, that's how it gets cancelled:
 *
 *   const answer = await backable((context) => select({ ... }, context));
 */
export async function backable<T>(
  ask: (context: { signal: AbortSignal }) => Promise<T>,
): Promise<T | Back> {
  const controller = new AbortController();
  const onKeypress = (_chunk: string, key?: Key): void => {
    if (key?.name === "escape") controller.abort(BACK);
  };

  process.stdin.on("keypress", onKeypress);
  try {
    return await ask({ signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted && controller.signal.reason === BACK) return BACK;
    throw err;
  } finally {
    process.stdin.off("keypress", onKeypress);
  }
}
