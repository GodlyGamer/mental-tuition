// The Electron half of `npm run desktop:dev`, cross-platform: points the
// shell at the running `next dev` server (MT_DEV_URL) and starts Electron.
// (The inline `MT_DEV_URL=… electron .` form only works in POSIX shells.)
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electron = require("electron"); // the binary path, from the electron package

spawn(electron, ["."], {
	stdio: "inherit",
	env: { ...process.env, MT_DEV_URL: process.env.MT_DEV_URL ?? "http://localhost:3000" },
}).on("exit", (code) => process.exit(code ?? 0));
