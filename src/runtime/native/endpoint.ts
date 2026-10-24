import { nativeCommand } from "./command";

export function validateEndpoint(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.startsWith("unix:///") || value.length <= 8 || value.length > 4096 || (/[?#]/.test(value) || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) throw new Error("LOCAL_ENDPOINT_REQUIRED");
}
export async function selectedEndpoint(): Promise<string> {
  const context = await nativeCommand(["docker", "context", "show"]);
  const value: unknown = process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT ? process.env.DOCKER_HOST
    : JSON.parse(await nativeCommand(["docker", "context", "inspect", context, "--format", "{{json .Endpoints.docker}}"])).Host;
  validateEndpoint(value);
  return value;
}
export interface NativeImages { readonly worker: string; readonly controller: string; readonly endpoint: string; }
