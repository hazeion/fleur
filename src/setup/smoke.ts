import type { HostCommandResult } from "./commands.ts";
export interface SmokeResult { readonly state: "ready" | "failed"; readonly cleanup: boolean; readonly reason?: string }
type Run = (args: readonly string[]) => Promise<HostCommandResult>;
function object(stdout: string): Record<string, unknown> | null {
  try { const value: unknown = JSON.parse(stdout); return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
}
function completed(result: HostCommandResult): boolean { return result.status === "completed" && result.exitCode === 0; }
export async function smokeContainer(run: Run, endpoint: string, image: string, metadata: string, architecture: string, cleanupRun: Run = run, artifact = false): Promise<SmokeResult> {
  const verifiedImage = object(metadata);
  const imageId = verifiedImage?.Id;
  if (typeof imageId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(imageId) || (artifact ? imageId !== image : !Array.isArray(verifiedImage?.RepoDigests) || !verifiedImage.RepoDigests.includes(image)) || verifiedImage?.Os !== "linux" || verifiedImage?.Architecture !== (architecture === "x64" ? "amd64" : architecture)) return { state: "failed", cleanup: true, reason: "image-identity" };
  const nonce = crypto.randomUUID();
  const name = `fleur-doctor-${nonce}`;
  const prefix = ["docker", "--host", endpoint];
  let id: string | null = null;
  let state: "ready" | "failed" = "failed";
  let cleanup = false;
  const owned = (value: Record<string, unknown> | null): value is Record<string, unknown> => {
    const config = value?.Config as { Labels?: Record<string, unknown> } | undefined;
    return typeof value?.Id === "string" && /^[a-f0-9]{64}$/.test(value.Id) && (id === null || value.Id === id) && value.Name === `/${name}` && value.Image === imageId && config?.Labels?.["dev.fleur.doctor-owner"] === nonce;
  };
  try {
    const created = await run([...prefix, "create", "--name", name, "--label", `dev.fleur.doctor-owner=${nonce}`, "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "128m", "--cpus", "1", "--pull", "never", ...artifact ? ["--entrypoint", "/usr/local/bin/bun", image] : [image, "/usr/local/bin/bun"], "-e", 'process.stdout.write("fleur-doctor-smoke")']);
    if (completed(created) && /^[a-f0-9]{64}$/.test(created.stdout.trim())) id = created.stdout.trim();
    const inspected = await run([...prefix, "inspect", id ?? name, "--format", "{{json .}}"]);
    const initial = completed(inspected) ? object(inspected.stdout) : null;
    if (owned(initial)) {
      id = initial.Id as string;
      if (completed(created)) {
        const started = await run([...prefix, "start", "--attach", id]);
        const finished = await run([...prefix, "inspect", id, "--format", "{{json .}}"]);
        const final = completed(finished) ? object(finished.stdout) : null;
        const status = final?.State as { Running?: unknown; ExitCode?: unknown; FinishedAt?: unknown } | undefined;
        if (completed(started) && started.stdout === "fleur-doctor-smoke" && owned(final) && status?.Running === false && status.ExitCode === 0 && typeof status.FinishedAt === "string" && Number.isFinite(Date.parse(status.FinishedAt)) && Date.parse(status.FinishedAt) > 0) state = "ready";
      }
    }
  } finally {
    const inspected = await cleanupRun([...prefix, "inspect", id ?? name, "--format", "{{json .}}"]);
    const candidate = completed(inspected) ? object(inspected.stdout) : null;
    if (owned(candidate)) {
      id = candidate.Id as string;
      cleanup = completed(await cleanupRun([...prefix, "rm", "--force", id]));
    }
  }
  return { state, cleanup };
}
