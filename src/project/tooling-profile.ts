import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { readMetadata, readMetadataText } from "../cli/project-pin";

export const compilerProfile = {
  compilerOptions: { target: "ESNext", module: "Preserve", moduleResolution: "bundler", types: ["bun"], strict: true, noUncheckedIndexedAccess: true, allowImportingTsExtensions: true, jsx: "react-jsx", jsxImportSource: "preact", noEmit: true, skipLibCheck: false },
  include: ["client/**/*.ts", "client/**/*.tsx", "server/**/*.ts", "server/**/*.tsx", "shared/**/*.ts", "tests/**/*.ts", "tests/**/*.tsx"],
};
export const oxlintProfile = { plugins: ["typescript"], categories: { correctness: "error" } };
export const eslintProfile = 'import tseslint from "typescript-eslint";\nexport default [...tseslint.configs.recommended];\n';

/** Local import aliases are admitted separately; they cannot disable compiler or lint checks. */
export async function hasToolingProfile(root: string): Promise<boolean> {
  try {
    const compiler = await readMetadata(join(root, "tsconfig.json"));
    if (!compiler || typeof compiler !== "object" || !("compilerOptions" in compiler) || !compiler.compilerOptions || typeof compiler.compilerOptions !== "object") return false;
    const options = { ...compiler.compilerOptions } as Record<string, unknown>;
    if (options.baseUrl !== undefined && options.baseUrl !== ".") return false;
    delete options.paths; delete options.baseUrl;
    return isDeepStrictEqual({ ...compiler, compilerOptions: options }, compilerProfile)
      && isDeepStrictEqual(await readMetadata(join(root, ".oxlintrc.json")), oxlintProfile)
      && await readMetadataText(join(root, "lint/eslint.config.mjs")) === eslintProfile;
  } catch { return false; }
}
