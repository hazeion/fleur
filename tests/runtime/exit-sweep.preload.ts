import { afterAll } from "bun:test";
import { sweep } from "./exit-sweep";

// A preload's afterAll is the only hook that runs once after every test file; process "exit" handlers do not run under bun test.
afterAll(sweep);
