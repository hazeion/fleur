/** Canary check for this fixture only, not a general source-admission implementation. */
export function assertBrowserOnly(files: readonly { name: string; content: string }[]): void {
  for (const file of files) {
    for (const marker of ["FLEUR_SERVER_SECRET_CANARY_23", "serverOnlyExerciseLookup", "server.tsx"]) {
      if (file.content.includes(marker)) throw new Error(`Server-only fixture marker in ${file.name}`);
    }
  }
}
