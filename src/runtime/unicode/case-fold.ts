import { caseFoldMappings } from "./case-fold-data";
const mappings = new Map(caseFoldMappings);
/** Unicode 17.0.0 default full folding. No locale or normalization dependency. */
export function caseFold(value: string): string {
  if (typeof value !== "string") throw new Error("Invalid case-fold input");
  return Array.from(value, point => mappings.get(point.codePointAt(0)!) ?? point).join("");
}
