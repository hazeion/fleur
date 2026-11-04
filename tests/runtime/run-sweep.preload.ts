import { afterAll } from "bun:test";
import { sweep, sweepNativeLeasesAfterRun } from "./run-sweep";

// A preload's afterAll is the only hook that runs once after every test file; process "exit" handlers do not run under bun test.
// Each Docker command may take up to 30 seconds on a loaded host, far beyond the default 5-second hook timeout.
sweepNativeLeasesAfterRun();
afterAll(sweep, 300_000);
