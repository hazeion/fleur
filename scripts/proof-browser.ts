import { chromium, type Browser } from "@playwright/test";

async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Owned browser operation exceeded its deadline")), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
/** Keep an explicit process handle so failed or cancelled proofs cannot strand Chromium. */
export async function proofBrowser(signal: AbortSignal) {
  signal.throwIfAborted();
  const server = await chromium.launchServer({ headless: true, host: "127.0.0.1", timeout: 10000 });
  const interrupted = () => { void server.kill().catch(() => {}); };
  signal.addEventListener("abort", interrupted, { once: true });
  let browser: Browser;
  try { signal.throwIfAborted(); browser = await chromium.connect(server.wsEndpoint(), { timeout: 10000 }); }
  catch {
    signal.removeEventListener("abort", interrupted);
    await bounded(server.kill(), 10000);
    throw new Error("The owned browser connection could not be established");
  }
  return { browser, async close() {
    signal.removeEventListener("abort", interrupted);
    let failure: unknown;
    try {
      if (browser.isConnected()) await bounded(browser.close(), 10000);
      await bounded(server.close(), 10000);
    } catch (error) { failure = error; await bounded(server.kill(), 10000); }
    const child = server.process();
    if (child.exitCode === null && child.signalCode === null) throw new Error("Owned browser process did not retire");
    if (failure && !signal.aborted) throw failure;
  } };
}

export async function closeProofContext(context: import("@playwright/test").BrowserContext): Promise<void> {
  const failures: unknown[] = [];
  for (const page of context.pages()) {
    try { await bounded(page.unrouteAll({ behavior: "wait" }), 10000); } catch (error) { failures.push(error); }
  }
  try { await bounded(context.close(), 10000); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Owned browser context did not close cleanly");
}

export async function usingProofContext<T>(browser: Browser, work: (context: import("@playwright/test").BrowserContext) => Promise<T>): Promise<T> {
  const context = await browser.newContext();
  const result = await Promise.resolve().then(() => work(context)).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  const closed = await closeProofContext(context).then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
  if (!result.ok || !closed.ok) throw new AggregateError([...(!result.ok ? [result.error] : []), ...(!closed.ok ? [closed.error] : [])], "Browser proof or context disposal failed");
  return result.value;
}
