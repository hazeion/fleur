import tseslint from "./lint/node_modules/typescript-eslint/dist/index.js";
export default [{
  files: ["**/*.ts"],
  languageOptions: { parser: tseslint.parser },
  plugins: { "@typescript-eslint": tseslint.plugin },
  rules: { "@typescript-eslint/no-explicit-any": "error" },
}];
