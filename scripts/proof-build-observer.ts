// Trusted proof-driver preload. Never shipped in the application package.
// Record only fixed stage names and exit codes, never arguments or tool output.
type Observation = { stage: string; exit: number | null };
const observations: Observation[] = [];
function record(stage: string): Observation {
  const observation = { stage, exit: null };
  observations.push(observation);
  if (observations.length > 64) observations.shift();
  return observation;
}
function stage(value: unknown): string {
  const command = Array.isArray(value) ? value : value && typeof value === "object" && "cmd" in value ? value.cmd : undefined;
  if (!Array.isArray(command)) return "other";
  const executable = typeof command[0] === "string" ? command[0].split("/").at(-1) : "";
  if (executable === "tar") return command.at(-1) === "manifest.json" ? "archive-manifest" : command.at(-1) === "index.json" ? "archive-index" : "tar";
  if (executable !== "docker") return "other";
  const args = command.slice(1);
  if (args[0] === "--host") args.splice(0, 2);
  const operation = args[0] === "image" ? args[1] : args[0];
  return ["build", "save", "inspect", "create", "start", "exec", "wait", "kill", "rm", "ls", "info"].includes(operation) ? `docker-${operation}` : "docker-other";
}
const spawn = Bun.spawn;
Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
  const observation = record(stage(args[0]));
  try {
    const child = spawn(...args);
    void child.exited.then(exit => { observation.exit = exit; }, () => {});
    return child;
  } catch (error) { observation.exit = -1; throw error; }
}) as typeof Bun.spawn;
const build = Bun.build;
Bun.build = async options => {
  const observation = record("bundle");
  try {
    const result = await build(options);
    observation.exit = result.success ? 0 : 1;
    return result;
  } catch (error) { observation.exit = -1; throw error; }
};
process.on("exit", code => {
  if (code !== 0) process.stderr.write(`[fleur-proof-build] ${JSON.stringify(observations)}\n`);
});
