import { superviseProduction } from "./supervisor";
const [root, host, port, deadline] = process.argv.slice(2);
if (!root || !host || !port || !/^[0-9]+$/.test(port) || !deadline || !/^[0-9]+$/.test(deadline)) process.exit(2);
await superviseProduction(root, host, Number(port), BigInt(deadline));
