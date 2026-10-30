import { createHash } from "node:crypto";
import type { BrowserBuild } from "../build/client";

type Asset = BrowserBuild["files"] extends ReadonlyMap<string, infer Value> ? Value : never;
const maximum = 256 * 1048576;
/** Immutable browser generations survive stale views, within one bounded owner. */
export class DevelopmentAssets {
  readonly #limit: number;
  readonly #files = new Map<string, { value: Asset; hash: string; bytes: number }>();
  #bytes = 0;
  constructor(limit = maximum) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) throw new Error("REQUEST_DENIED");
    this.#limit = limit;
  }
  get(path: string): Asset | undefined { return this.#files.get(path)?.value; }
  /** Check before retiring the old runtime; commit atomically at publication. */
  prepare(browser: BrowserBuild): () => void {
    const plan = () => {
      const additions = new Map<string, { value: Asset; hash: string; bytes: number }>();
      let total = this.#bytes;
      for (const [path, value] of browser.files) {
        // Presentation assets have the existing mutable no-cache URL contract.
        // The current admitted generation, not this immutable cache, serves them.
        if (value.cache === "no-cache") continue;
        const hash = createHash("sha256").update(value.body).digest("hex"), previous = this.#files.get(path);
        if (previous) {
          if (previous.hash !== hash || previous.value.type !== value.type) throw new Error("SOURCE_REJECTED");
          continue;
        }
        const bytes = typeof value.body === "string" ? Buffer.byteLength(value.body) : value.body.byteLength;
        total += bytes;
        if (total > this.#limit) throw new Error("BROWSER_ASSET_CAPACITY");
        additions.set(path, { value: Object.freeze({ ...value, body: typeof value.body === "string" ? value.body : new Uint8Array(value.body) }), hash, bytes });
      }
      return { additions, total };
    };
    plan();
    return () => {
      // A second prepared publication cannot overbook capacity or partially add files.
      const { additions, total } = plan();
      for (const [path, value] of additions) this.#files.set(path, value);
      this.#bytes = total;
    };
  }
}
