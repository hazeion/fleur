/** Startup variables holding retrieval secrets; only the trusted broker reads them. */
export const retrievalSecretVariables: readonly string[] = Object.freeze(["FLEUR_RETRIEVAL_CREDENTIALS"]);
/** An environment for host child processes such as the Docker client, without retrieval secrets. */
export function withoutRetrievalSecrets(environment: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const result = { ...environment };
  for (const name of retrievalSecretVariables) delete result[name];
  return result;
}
