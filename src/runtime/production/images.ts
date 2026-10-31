import { nativeCommand } from "../native/command";
import { validateEndpoint, type NativeImages } from "../native/endpoint";
import type { ArtifactManifest } from "./artifact";

type Role = ArtifactManifest["images"]["worker"];
const owner = "dev.fleur.read-image-owner";
/** The exact image under this tag, or null when it is absent or differs. Nothing else is ever selected. */
async function exactImage(endpoint: string, role: Role): Promise<string | null> {
  let metadata: { Id?: unknown; RepoTags?: unknown; Config?: { Labels?: Record<string, unknown> } };
  try { metadata = JSON.parse(await nativeCommand(["docker", "--host", endpoint, "image", "inspect", role.tag, "--format", "{{json .}}"])); }
  catch { return null; }
  const id = metadata.Id, label = metadata.Config?.Labels?.[owner];
  if (typeof id !== "string" || !role.identities.includes(id) || !Array.isArray(metadata.RepoTags) || !metadata.RepoTags.includes(role.tag)) return null;
  // The build tag embeds the same random owner the image was labeled with.
  return typeof label === "string" && role.tag.includes(label) ? id : null;
}
/** Imports the verified archive only when the exact images are not already present. No network path exists here. */
export async function importArtifactImages(root: string, manifest: ArtifactManifest, endpoint: string, timeoutMs: number): Promise<NativeImages> {
  validateEndpoint(endpoint);
  const { worker: workerRole, controller: controllerRole, archive } = manifest.images;
  let worker = await exactImage(endpoint, workerRole), controller = await exactImage(endpoint, controllerRole);
  if (!worker || !controller) {
    await nativeCommand(["docker", "--host", endpoint, "load", "--quiet", "--input", `${root}/${archive}`], Math.max(1000, timeoutMs));
    worker = await exactImage(endpoint, workerRole); controller = await exactImage(endpoint, controllerRole);
  }
  if (!worker || !controller) throw new Error("ARTIFACT_INVALID");
  return { worker, controller, endpoint };
}
