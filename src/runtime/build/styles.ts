import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { Scanner } from "@tailwindcss/oxide";
import { presentationClassStrings } from "./class-candidates";
import type { AdmittedProject } from "./admission";

/** Only the release-owned theme and frozen admitted source enter compilation. */
export async function compileStyles(project: AdmittedProject): Promise<string> {
  const stylesheet = await readFile(fileURLToPath(import.meta.resolve("tailwindcss/index.css")), "utf8");
  const scanner = new Scanner({ sources: [] });
  const candidates = scanner.scanFiles(presentationClassStrings(project).map(content => ({ content, extension: "html" })));
  if (candidates.length > 100_000) throw new Error("SOURCE_REJECTED");
  // No config/module/stylesheet loader exists here. App files cannot introduce
  // @plugin, @config, @import or additional source scans into the owned theme.
  const compiler = await compile(stylesheet);
  const css = compiler.build(candidates);
  if (Buffer.byteLength(css) > 8_388_608) throw new Error("SOURCE_REJECTED");
  return css;
}
