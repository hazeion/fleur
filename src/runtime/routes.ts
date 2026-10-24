import { matchPage, type Page } from "../routing";

/** Choose the most specific matching route before validating its parameters. */
export function selectPage(pages: readonly Page[], path: string): { page: Page; params: unknown } | null {
  const ordered = [...pages].sort((a, b) => {
    const left = a.path.split("/"), right = b.path.split("/");
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      const difference = Number(left[index]!.startsWith(":")) - Number(right[index]!.startsWith(":"));
      if (difference) return difference;
    }
    return 0;
  });
  for (const page of ordered) {
    try { const params = matchPage(page, path); if (params !== null) return { page, params }; }
    catch { throw new Error("ROUTE_INVALID"); }
  }
  return null;
}
