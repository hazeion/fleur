import { monotonicNanoseconds } from "./state";
import { supervise } from "./supervisor";
const [project, host, port, timeout, mode, ownership] = process.argv.slice(2);
if (!project || !host || !timeout || !/^[0-9]+$/.test(timeout) || port !== "auto" && (!port || !/^[0-9]+$/.test(port))) process.exit(2);
await supervise(project, host, port === "auto" ? undefined : Number(port), Math.max(0, Number(BigInt(timeout) - monotonicNanoseconds()) / 1000000), mode === "foreground", ownership === "owned-fd-3" ? 3 : undefined, BigInt(timeout));
