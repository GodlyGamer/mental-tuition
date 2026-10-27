/**
 * Mental Tuition — the Electron shell (wrapper milestone, 2026-09-17).
 *
 * What this process is and is not:
 *   IS:  a thin launcher + security guard around the app's real server —
 *        `next build`'s standalone server.js (Next 16), spawned as a child
 *        on 127.0.0.1 with the BYOK auth file and the MT_DATA_DIR seam.
 *   NOT: a host for any app logic. Everything — teacher turns, extraction,
 *        the graph — runs in the Next server, unchanged.
 *
 * Pattern (fact-checked 2026-09-17 against current Electron 44 / Next 16
 * docs — see .memory release-strategy + electron-wrapper notes):
 *   - spawn via process.execPath + ELECTRON_RUN_AS_NODE=1 (Electron's
 *     bundled Node 24; the runAsNode fuse must stay enabled);
 *   - the server dir ships UNPACKED via extraResources (asar archives are
 *     read-only and native .node/dylib can't dlopen from one);
 *   - all mutable state under userData (never inside the .app bundle —
 *     translocated apps are read-only);
 *   - keys ride the child's ENV, never argv; auth.json (BYOK) is a flat
 *     {VAR: value} JSON map, plaintext, mode 0600 — server-managed since
 *     the auth-keys wave (2026-09-19): the child reads/writes it DIRECTLY
 *     (MT_AUTH_FILE below) and reflects values into its own env. The old
 *     spawn-time env injection retired with that wave — a copy made here
 *     would shadow every settings-page key change until restart.
 */

const { app, BrowserWindow, Menu, ipcMain, session, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

// Mirrors SIDEBAR_AUTOCLOSE in components/sidebar.tsx — keep in sync (the
// renderer owns the number; this is the IPC widen target).
const SIDEBAR_AUTOCLOSE = 928;

// The personal fork's name: MentalTuition (2026-10-24), then "Mental
// Tuition" (2026-10-27) with its own appId com.mentaltuition.MentalTuition —
// 0.3.x installs don't update over it; uninstall the old build once.
const PRODUCT_NAME = "Mental Tuition";
// Earlier userData folder names, newest first: migrateUserData copies the
// first one that exists.
const OLD_PRODUCT_NAMES = ["MentalTuition", "LearnHarness"];

// APP NAME → userData (owner, 2026-10-10): the Application Support dir is
// exactly the product name in dev AND packaged. Packaged Electron would
// otherwise derive it from package.json "name" (lowercase "mentaltuition"),
// and productName metadata alone doesn't reach app.name. Must run before
// the MT_DEV_URL suffix below — dev becomes "Mental Tuition-dev".
app.setName(PRODUCT_NAME);

/** Each rename moved userData (%APPDATA%\LearnHarness → MentalTuition →
 *  Mental Tuition). Once (the marker file), before anything reads it, copy
 *  the newest old folder over — the keys (auth.json), localStorage, this
 *  machine's workspace choice and setup record, the Gemini download —
 *  leaving Chromium's caches behind and never overwriting a file already
 *  there. The old folder stays as it was. Dev copies from the old "-dev"
 *  folders. Runs from main(), after the single-instance lock. */
function migrateUserData() {
	const next = app.getPath("userData");
	const suffix = process.env.MT_DEV_URL ? "-dev" : "";
	const marker = path.join(next, ".migrated-from-mentaltuition");
	if (fs.existsSync(marker)) return;
	const old = OLD_PRODUCT_NAMES.map((name) => path.join(app.getPath("appData"), name + suffix)).find((dir) => fs.existsSync(dir));
	if (!old) return;
	const caches = new Set(["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "Shared Dictionary", "blob_storage"]);
	try {
		fs.cpSync(old, next, {
			recursive: true,
			force: false,
			filter: (src) => !caches.has(path.relative(old, src).split(path.sep)[0]),
		});
		fs.writeFileSync(marker, `${new Date().toISOString()}
`);
		log(`copied this machine's settings from ${old}`);
	} catch (err) {
		log(`couldn't copy settings from ${old}: ${err?.message ?? err}`);
	}
}
const AUTH_FILE = () => path.join(app.getPath("userData"), "auth.json");
/** Per-machine state that must not sync (downloaded programs, the setup
 *  record): config.ts LOCAL_ROOT. */
const LOCAL_DIR = () => path.join(app.getPath("userData"), "local");

/* ── The workspace (personal fork, 2026-10-24) ─────────────────────────────
 * Everything the learner makes lives in ONE folder they pick, meant to sit
 * in Google Drive so a PC and a laptop share it:
 *   <workspace>/data/      chats, graph, settings (MT_DATA_DIR)
 *   <workspace>/study/     the practice-paper tree (MT_STUDY_DIR)
 *   <workspace>/.claude/   the paper skills, refreshed from the app on launch
 * The choice is per machine (userData/workspace.json): Drive's letter can
 * differ between computers. Sign-ins, keys (auth.json), logs and the
 * Antigravity download stay in userData. Drive can't merge two computers
 * writing at once, so <workspace>/.mt-open.json says who has it open. */
const WORKSPACE_FILE = () => path.join(app.getPath("userData"), "workspace.json");
const OPEN_FILE = (ws) => path.join(ws, ".mt-open.json");
// Builds before the 2026-10-27 rename write .lh-open.json: read it too until
// both computers are on the new build.
const LEGACY_OPEN_FILE = (ws) => path.join(ws, ".lh-open.json");
const OPEN_STALE_MS = 3 * 60 * 1000;
let workspace = null;
let openHeartbeat = null;

function readWorkspace() {
	try {
		// A hand-edited file may start with a byte-order mark (Windows editors).
		const { folder } = JSON.parse(fs.readFileSync(WORKSPACE_FILE(), "utf-8").replace(/^﻿/, ""));
		if (typeof folder === "string" && fs.existsSync(folder)) return folder;
	} catch {
		/* none chosen yet */
	}
	return null;
}

/** Google Drive for desktop mounts "My Drive" on a drive letter (G: by
 *  default); the picker starts there when it exists. */
function driveFolder() {
	if (process.platform === "win32") {
		for (const letter of "GHIJKLMNOPQRSTUVWXYZDEF") {
			const myDrive = `${letter}:\\My Drive`;
			if (fs.existsSync(myDrive)) return myDrive;
		}
	}
	return app.getPath("documents");
}

async function pickWorkspace({ first }) {
	for (;;) {
		if (first) {
			const { response } = await dialog.showMessageBox({
				type: "info",
				title: PRODUCT_NAME,
				message: "Choose where Mental Tuition keeps your work",
				detail:
					"Pick or create a folder in Google Drive (for example My Drive\\Mental Tuition). Your chats, knowledge graph, settings and study modules go there, so your other computer can use them too.\n\nYou can change it later in Settings → This computer.",
				buttons: ["Choose folder…", "Quit"],
				defaultId: 0,
				cancelId: 1,
			});
			if (response === 1) return null;
		}
		const result = await dialog.showOpenDialog({
			title: "Mental Tuition folder",
			defaultPath: workspace ?? driveFolder(),
			buttonLabel: "Use this folder",
			properties: ["openDirectory", "createDirectory", "promptToCreate"],
		});
		if (!result.canceled && result.filePaths[0]) {
			const folder = result.filePaths[0];
			fs.mkdirSync(folder, { recursive: true });
			return folder;
		}
		if (!first) return null;
	}
}

/** Remember the folder for this machine (once it's been claimed). */
function saveWorkspace(folder) {
	fs.writeFileSync(WORKSPACE_FILE(), `${JSON.stringify({ folder }, null, "\t")}\n`);
	log(`workspace: ${folder}`);
}

/** Copy the paper skills and agents the app ships into <workspace>/.claude
 *  (the skill runs load them from there). Overwrites the shipped files;
 *  anything else in .claude is left alone. */
function refreshWorkspaceSkills(ws) {
	const shipped = app.isPackaged ? path.join(process.resourcesPath, "claude") : path.join(__dirname, "..", ".claude");
	for (const dir of ["skills", "agents"]) {
		const from = path.join(shipped, dir);
		if (!fs.existsSync(from)) continue;
		try {
			fs.cpSync(from, path.join(ws, ".claude", dir), { recursive: true, force: true });
		} catch (err) {
			log(`couldn't refresh ${dir} in the workspace: ${err?.message ?? err}`);
		}
	}
}

/** Warn when another computer has the workspace open; then claim it. */
async function claimWorkspace(ws) {
	for (const file of [OPEN_FILE(ws), LEGACY_OPEN_FILE(ws)]) {
		let other;
		try {
			other = JSON.parse(fs.readFileSync(file, "utf-8"));
		} catch {
			continue; /* nobody has it open */
		}
		const age = Date.now() - Date.parse(other.at);
		if (other.host && other.host !== os.hostname() && age < OPEN_STALE_MS) {
			const { response } = await dialog.showMessageBox({
				type: "warning",
				title: PRODUCT_NAME,
				message: `Mental Tuition looks open on ${other.host}`,
				detail:
					"Using the same folder on two computers at once can make Google Drive keep conflicting copies of your chats and graph. Close it there first, or open it here anyway.",
				buttons: ["Open anyway", "Quit"],
				defaultId: 1,
				cancelId: 1,
			});
			if (response === 1) return false;
			break;
		}
	}
	const beat = () => {
		try {
			fs.writeFileSync(OPEN_FILE(ws), JSON.stringify({ host: os.hostname(), at: new Date().toISOString() }));
		} catch {
			/* Drive offline: best effort */
		}
	};
	beat();
	clearInterval(openHeartbeat);
	openHeartbeat = setInterval(beat, 60 * 1000);
	return true;
}

function releaseWorkspace(ws) {
	clearInterval(openHeartbeat);
	if (!ws) return;
	try {
		const mine = JSON.parse(fs.readFileSync(OPEN_FILE(ws), "utf-8"));
		if (mine.host === os.hostname()) fs.rmSync(OPEN_FILE(ws), { force: true });
	} catch {
		/* already gone */
	}
}

/** The server's view of the workspace (config.ts). */
function workspaceEnv(ws) {
	return {
		MT_WORKSPACE_DIR: ws,
		MT_DATA_DIR: path.join(ws, "data"),
		MT_STUDY_DIR: path.join(ws, "study"),
		MT_LOCAL_DIR: LOCAL_DIR(),
	};
}

/** The packaged standalone server (extraResources → Resources/server).
 *  In dev MT_DEV_URL short-circuits everything: no spawn, no packaging —
 *  the window points at the running `next dev` server (full HMR). */
function serverEntry() {
	// extraResources ships the whole .next payload under server/standalone/
	// (copied from .next with an explicit filter — see electron-builder.yml).
	return path.join(process.resourcesPath, "server", "standalone", "server.js");
}

// ─── Single instance: two instances would fight over the data dir ─────────
// ─── Browser-service helper (Wave E stage 3, owner 2026-10-10) ────────
// The render engines for agent jobs: PDFs and SVGs rasterize natively
// (pdfjs+Skia, resvg — no browser); DEMOS execute JS and need one. The
// app's own Chromium serves that via this helper — the server spawns
//   <this binary> --browser-service
// and connects over CDP (system Chrome stays the fallback). Handshake:
// the helper prints "BROWSER_SERVICE_CDP <port>" on stdout once the CDP
// endpoint listens. Lifetime: parent IPC disconnect/death = quit.
// MUST run before the single-instance lock — a helper is a second
// instance of this very binary, and before the MT_DEV_URL redirect — the
// helper owns no user data at all.
if (process.argv.includes("--browser-service")) {
	const { waitForBrowserService } = require("./browser-service-readiness.cjs");
	// Own the helper's entire startup lifetime, including the readiness wait.
	const lifetime = new AbortController();
	const parentClosed = () => {
		lifetime.abort(new Error("browser-service parent IPC disconnected"));
		app.quit();
	};
	(async () => {
		try {
			// Full Windows Electron replaces stdin with synthetic EOF. Use the
			// real Node IPC channel, and refuse to start an unowned helper.
			if (!process.channel || !process.connected) throw new Error("browser-service requires connected parent IPC");
			process.once("disconnect", parentClosed);
			app.dock?.hide();
			const port = await freePort();
			// Must land before app-ready for Chromium to pick it up.
			app.commandLine.appendSwitch("remote-debugging-port", String(port));
			await app.whenReady();
			// A hidden window keeps the app lifecycle ordinary on every
			// platform (no window-all-closed handler is installed here).
			const win = new BrowserWindow({ show: false });
			await win.loadURL("about:blank");
			// Window load is not a DevTools HTTP readiness barrier. Confirm the
			// endpoint before both production and smoke clients see the handshake.
			await waitForBrowserService(port, { signal: lifetime.signal });
			if (!lifetime.signal.aborted) console.log(`BROWSER_SERVICE_CDP ${port}`);
		} catch (err) {
			if (lifetime.signal.aborted) return; // Parent disconnect is normal.
			console.error("browser-service failed:", err);
			app.exit(1);
		}
	})();
} else {
	// Dev shell (MT_DEV_URL) runs BESIDE the packaged app, not instead of it:
	// its own userData so (a) the single-instance lock — checked below — doesn't
	// silently kill it, and (b) it never reads/writes the real app's
	// localStorage, auth.json, or logs. Must run before the lock check.
	if (process.env.MT_DEV_URL) {
		app.setPath("userData", `${app.getPath("userData")}-dev`);
	}

	// The whole normal boot — lock included — lives in this else: a helper is
	// a SECOND instance of this very binary on purpose (the running app owns
	// the lock), so it must never reach this check.
	if (!app.requestSingleInstanceLock()) {
		app.quit();
	} else {
		app.on("second-instance", () => {
			const win = BrowserWindow.getAllWindows()[0];
			if (win) {
				if (win.isMinimized()) win.restore();
				win.focus();
			}
		});
		main();
	}
}

let serverProcess = null;

// A GUI shell must never die to a stray exception (EPIPE dialogs, a race
// in an event handler): the window + child server are the product, and
// anything main-side is recoverable by logging it. Log-and-continue.
process.on("uncaughtException", (err) => {
	try {
		log(`uncaught: ${err?.stack ?? err}`);
	} catch {
		/* nothing left to write to */
	}
});

/** A free TCP port (listen(0) → the kernel assigns one). The close→spawn
 *  race is theoretical; localhost ports are rarely contended, and a failed
 *  spawn surfaces in the health check with the child's stderr in the log. */
function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

/** BYOK keys: auth.json in userData, flat {VAR: value} map, 0600 —
 *  SERVER-MANAGED since the auth-keys wave (2026-09-19). This shell no
 *  longer reads or injects it: the child gets MT_AUTH_FILE below and does
 *  its own read/reflect/write, so a key saved in the settings page takes
 *  effect on the next model call — no restart. Real environment variables
 *  still win over the file inside the child (its documented rule). */

function log(line) {
	const stamp = new Date().toISOString();
	// The stdout write is guarded (EPIPE hardening, 2026-10-10): a packaged
	// app launched with a consumer-owned pipe (a launcher that exits, a
	// piped run) must not die on its next log line when the pipe breaks.
	// The file below stays the durable channel.
	try {
		console.log(`[mt ${stamp}] ${line}`);
	} catch {
		/* stdout gone — userData/logs/main.log still carries it */
	}
	// Belt and braces: also append to userData/logs so a misbehaving child
	// can be diagnosed after the window is gone. Best effort only.
	try {
		const dir = path.join(app.getPath("userData"), "logs");
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(path.join(dir, "main.log"), `[${stamp}] ${line}\n`);
	} catch {
		/* best effort */
	}
}

function startServer(port) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[serverEntry()],
			{
				cwd: path.dirname(serverEntry()),
				env: {
					...process.env,
					ELECTRON_RUN_AS_NODE: "1",
					NODE_ENV: "production",
					PORT: String(port),
					HOSTNAME: "127.0.0.1", // the server defaults to 0.0.0.0 — never
					...workspaceEnv(workspace),
					// The auth/keys store — the child reads AND writes this file itself
					// (no env injection anymore: a spawn-time copy would shadow every
					// settings-page key change until restart; env wins over file).
					MT_AUTH_FILE: AUTH_FILE(),
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		serverProcess = child;
		const fwd = (buf) => buf.toString().trimEnd().split("\n").forEach((l) => l && log(`server: ${l}`));
		child.stdout.on("data", fwd);
		child.stderr.on("data", fwd);
		child.on("exit", (code, signal) => {
			log(`server exited (code=${code} signal=${signal})`);
			serverProcess = null;
		});
		resolve(child);
	});
}

/** No "ready" event exists — poll until the server answers (docs-confirmed). */
function waitUntilUp(url, tries = 150) {
	return new Promise((resolve, reject) => {
		const attempt = (n) => {
			const req = http.get(url, (res) => {
				res.resume();
				resolve(res.statusCode !== undefined);
			});
			req.on("error", () => {
				if (n <= 0) reject(new Error(`server never answered on ${url}`));
				else setTimeout(() => attempt(n - 1), 200);
			});
		};
		attempt(tries);
	});
}

function killServer() {
	if (!serverProcess) return Promise.resolve();
	const child = serverProcess;
	serverProcess = null;
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGTERM");
	setTimeout(() => {
		try {
			child.kill("SIGKILL");
		} catch {
			/* already gone */
		}
	}, 3000);
	return exited;
}

/** Windows/Linux window-controls overlay for a theme: transparent over the
 *  app's own ground, with symbols in the theme's ink. */
function titleBarOverlayFor(mode) {
	return { color: "#00000000", symbolColor: mode === "light" ? "#0e0e0f" : "#f2f2f3" };
}

/** Security posture (all defaults asserted explicitly; the guards are the
 *  checklist's own recommendations for localhost-app shells):
 *  - deny-by-default permission handler allowing only our loopback origin
 *    (groundwork for the mic/STT milestone — Electron auto-approves by
 *    default, we do not);
 *  - will-navigate pinned to the app origin; window.open always denied —
 *    external links go to the real browser via shell.openExternal. */
function createWindow(url) {
	const win = new BrowserWindow({
		width: 1440,
		height: 900,
		title: PRODUCT_NAME,
		// Merged chrome (owner, 2026-09-17): the system title bar is gone;
		// the app's own 60px header bands ARE the title bar. The traffic
		// lights float over the sidebar's wordmark band, vertically
		// Aligned to the PHASE PILL's drawn box, not the band's geometric
		// center (owner ask, 2026-09-17): macOS centers each 12px circle at
		// y+6.75, and the pill box center measures 29.25 in the running app
		// (band 0–59.5, pill box 19–39.5) — y 22.5 lands the circles at
		// 29.25, exactly on the pill. Wordmark gutter: components/sidebar.tsx.
		// Dragging comes from the renderer's .mt-drag bands (app/globals.css).
		...(process.platform === "darwin"
			? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 22.5 } }
			: {
				titleBarStyle: "hidden",
				// Native min/max/close on the right, at the OS's compact default
				// height. Do not force the zoom-invariant native overlay to match
				// the renderer's 60 CSS px bar: zooming out would cover its border.
				// The renderer reserves the actual width via env(titlebar-area-*).
				// Transparent so the theme's lit ground shows behind the
				// controls; the symbol color follows the theme ("mt:theme").
				titleBarOverlay: titleBarOverlayFor("dark"),
				// Keep the custom bar alone; Alt reveals the native menu.
				autoHideMenuBar: true,
			}),
		webPreferences: {
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			preload: path.join(__dirname, "preload.cjs"),
		},
		// Live-resize + first-paint flash (owner, 2026-09-17): during a resize
		// the native window surface changes size before Chromium's compositor
		// has a frame at the new size, and the gap shows the window's NATIVE
		// background — Electron's default is white, glaring on a dark app.
		// The app background (#141414) fills the lag instead. `show: false` +
		// ready-to-show is the same treatment for first paint: the window
		// appears only once the page has actually rendered.
		backgroundColor: "#141414",
		show: false,
		// Narrow-window behavior (owner, 2026-09-17): 640px is the floor —
		// below it even a wrapped chrome row gets cramped and the chat header
		// (lights gutter 92 + toggle + title) runs out of room. The sidebar
		// auto-closes below 928 = 640 + 288 (sidebar) in the renderer
		// (components/sidebar.tsx, SIDEBAR_AUTOCLOSE); its "mt:expand-window"
		// IPC widens the window back to that threshold.
		minWidth: 640,
		minHeight: 600,
	});

	const allowedOrigin = () => new URL(url).origin;
	// Deny-by-default; the ONLY grants are media (mic/STT groundwork) and
	// clipboard-sanitized-write — the copy affordances in the transcript
	// (md-blocks copy corners) call navigator.clipboard.writeText(), which
	// Chromium only honors with that permission (chrome-melt tweaks wave,
	// 2026-09-19; before this grant every copy silently rejected). Still
	// loopback-origin only — Electron's default is auto-approve-everything,
	// and we do not ship that.
	// "local-fonts": the appearance section's reading-font picker (2026-09-26).
	const allowedPermissions = new Set(["media", "clipboard-sanitized-write", "local-fonts"]);
	const fromOwnOrigin = (origin, permission) =>
		origin === allowedOrigin() && allowedPermissions.has(permission);
	session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
		const requestOrigin = details.requestingUrl ? new URL(details.requestingUrl).origin : null;
		callback(fromOwnOrigin(requestOrigin, permission));
	});
	session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => {
		return fromOwnOrigin(origin, permission);
	});

	win.webContents.on("will-navigate", (event, target) => {
		if (new URL(target).origin !== allowedOrigin()) {
			event.preventDefault();
			void shell.openExternal(target);
		}
	});
	win.webContents.setWindowOpenHandler(({ url: target }) => {
		void shell.openExternal(target);
		return { action: "deny" };
	});

	void win.loadURL(url);
	// Zoom truth reaches the renderer for EVERY load (reload, nav): the
	// renderer's --mt-zoom must never go stale. The fallback catcher below
	// covers ⌘= / layout variants the menu's ⌘Plus may not claim — menu-
	// claimed keys never reach before-input-event, so exactly one of the
	// two applies any given zoom keypress.
	win.webContents.on("did-finish-load", () => {
		win.webContents.send("mt:zoom", win.webContents.getZoomFactor());
	});
	win.webContents.on("before-input-event", (event, input) => {
		if (input.type !== "keyDown" || !(input.meta || input.control)) return;
		if (input.key === "=" || input.key === "+") zoomStep(win, +1);
		else if (input.key === "-") zoomStep(win, -1);
		else if (input.key === "0") applyZoom(win, 1);
		else return;
		event.preventDefault();
	});

	win.once("ready-to-show", () => win.show());
	return win;
}

/* ── Zoom (owner round 7, 2026-10-05): ⌘±/⌘0 as an OWNED ladder ──────────
 * The stock zoomIn/zoomOut roles change zoomLevel silently — the renderer
 * never learns the factor, and the native traffic lights (physical-fixed,
 * hiddenInset) drift out of relation to the scaled chrome: the graph
 * button rides away from them zoomed in, content slides under them
 * zoomed out. Here zoom is explicit: a factor ladder, applied through
 * setZoomFactor, and broadcast to the renderer ("mt:zoom" — it publishes
 * --mt-zoom so gutter lengths can divide by it and stay PHYSICAL-
 * constant). The traffic lights themselves stay at their construction
 * position ({x:16, y:22.5} — Electron 44 has NO runtime setter, only
 * the BrowserWindow option), which is HIG-correct anyway: native lights
 * hug the window corner while the web chrome compensates around them.
 * Vertical note: at large factors the taller bands' content centers
 * drift below the fixed lights — accepted (the alternative, moving the
 * lights, is impossible without rebuilding the window). */
const ZOOM_LADDER = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

/* ── Auto-update (Wave C, owner 2026-10-10: silent download + restart ─────
 * banner; checks at startup + every 24h) ─────────────────────────────────
 *
 * Feed: GitHub Releases (electron-builder.yml publish → app-update.yml,
 * baked + signed into the bundle). macOS needs the app signed (it is —
 * Developer ID) and updates ride the zip target (Squirrel.Mac); blockmaps
 * give differential downloads for free. Windows uses NSIS; Linux uses
 * AppImage or DebUpdater (6.8.9 supports deb; installation can request
 * administrator permission via the package manager — owner 2026-10-11).
 *
 * Hard rules:
 *  - DEV NEVER UPDATES: !app.isPackaged skips the updater entirely — the
 *    dev world runs `next dev` and has no signed bundle.
 *  - THE UPDATER CAN NEVER TAKE THE APP DOWN: every event and check is
 *    caught and logged (feed down, disk full, bad signature — all just
 *    log lines; the app keeps working, update or no update).
 *  - MT_UPDATE_FEED (env): overrides the baked GitHub feed with a generic
 *    local server — the pre-release verification drill (serve
 *    latest-mac.yml + zip + blockmap from any localhost HTTP dir and
 *    watch a real installed copy find/download/restart). Test-only seam.
 *
 * Install path: the downloaded update applies on quit (autoInstallOnAppQuit
 * — Squirrel.Mac stages natively and swaps on relaunch). The renderer
 * banner asks for an immediate restart via "mt:update-install"; we kill
 * the child server FIRST — deterministic ordering: the server lives
 * inside the .app bundle Squirrel is about to replace (extraResources),
 * and before-quit alone would race the swap. */
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
let autoUpdater = null; // electron-updater's, packaged builds only

function broadcastUpdateStatus(status) {
	for (const win of BrowserWindow.getAllWindows()) {
		try {
			win.webContents.send("mt:update-status", status);
		} catch {
			/* window mid-teardown — the next push retries */
		}
	}
}

/** Settings → General → Auto-update. The shell reads the learner's record
 *  straight from the workspace (the server owns the file; the default is on).
 *  Only automatic checks respect it — "Check for Updates…" always works. */
function autoUpdateEnabled() {
	if (!workspace) return true;
	try {
		const record = JSON.parse(fs.readFileSync(path.join(workspace, "data", "settings.json"), "utf-8").replace(/^﻿/, ""));
		return record?.general?.autoUpdate !== false;
	} catch {
		return true;
	}
}

function checkForUpdates({ manual = false } = {}) {
	if (!autoUpdater) return;
	if (!manual && !autoUpdateEnabled()) {
		log("auto-update: automatic checks are off in Settings");
		return;
	}
	autoUpdater
		.checkForUpdates()
		.then((result) => {
			// The download itself is silent (autoDownload); the banner fires on
			// update-downloaded. Manual checks additionally answer directly.
			if (!manual) return;
			const version = result?.updateInfo?.version;
			if (!version) dialog.showMessageBox({ type: "info", message: "You're up to date.", detail: `Mental Tuition ${app.getVersion()} is the latest version.` });
		})
		.catch((err) => {
			log(`update check failed: ${err?.message ?? err}`);
			if (manual) dialog.showMessageBox({ type: "warning", message: "Couldn't check for updates.", detail: String(err?.message ?? err) });
		});
}

function installUpdateNow() {
	// Kill the server BEFORE the quit-and-install (see block comment).
	try {
		killServer();
	} catch {
		/* already dead */
	}
	autoUpdater?.quitAndInstall();
}

function setupAutoUpdater() {
	if (!app.isPackaged) {
		log("auto-update: dev build — updater disabled");
		return;
	}
	try {
		autoUpdater = require("electron-updater").autoUpdater;
	} catch (err) {
		log(`auto-update: electron-updater unavailable (${err?.message ?? err}) — updates disabled`);
		return;
	}
	const feed = process.env.MT_UPDATE_FEED;
	if (feed) {
		autoUpdater.setFeedURL({ provider: "generic", url: feed });
		log(`auto-update: MT_UPDATE_FEED override → ${feed}`);
	}
	autoUpdater.autoDownload = true;
	autoUpdater.autoInstallOnAppQuit = true;
	// Route every updater log line through the shell's own log (userData/
	// logs/main.log) — feed failures must be diagnosable after the fact.
	autoUpdater.logger = {
		info: (m) => log(`updater: ${m}`),
		warn: (m) => log(`updater warn: ${m}`),
		debug: (m) => {}, // too chatty for the persistent log
		error: (m) => log(`updater error: ${m}`),
	};
	autoUpdater.on("update-downloaded", (info) => {
		log(`update downloaded: ${info?.version} — banner shown`);
		broadcastUpdateStatus({ status: "downloaded", version: info?.version ?? null });
	});
	autoUpdater.on("error", (err) => log(`updater error: ${err?.message ?? err}`));
}

function zoomStep(win, dir) {
	const current = win.webContents.getZoomFactor();
	const next =
		dir > 0
			? ZOOM_LADDER.find((f) => f > current + 0.001) ?? ZOOM_LADDER[ZOOM_LADDER.length - 1]
			: [...ZOOM_LADDER].reverse().find((f) => f < current - 0.001) ?? ZOOM_LADDER[0];
	applyZoom(win, next);
}

function applyZoom(win, factor) {
	factor = Math.min(2, Math.max(0.75, factor)); // ladder clamps; ⌘0 = 1
	win.webContents.setZoomFactor(factor);
	win.webContents.send("mt:zoom", factor);
}

/** macOS needs an application menu with the Edit roles — without one,
 *  Cmd+C/V/A do nothing in the renderer. Everything else stays minimal. */
function installMenu() {
	const template = [
		{
			label: app.name,
			submenu: [
				{ role: "about" },
				// Manual check (Wave C): answers via native dialog — no renderer
				// round-trip. The 24h automatic checks stay silent.
				{ label: "Check for Updates…", click: () => checkForUpdates({ manual: true }) },
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ type: "separator" },
				{ role: "quit" },
			],
		},
		{ label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
		{
			label: "View",
			submenu: [
				{ role: "reload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				// OWNED zoom (see applyZoom): the roles change zoomLevel
				// silently; these broadcast the factor and re-seat the
				// traffic lights. The renderer's --mt-zoom depends on
				// hearing every change.
				{
					label: "Actual Size",
					accelerator: "CommandOrControl+0",
					click: () => applyZoom(BrowserWindow.getAllWindows()[0], 1),
				},
				{
					label: "Zoom In",
					accelerator: "CommandOrControl+Plus",
					click: () => zoomStep(BrowserWindow.getAllWindows()[0], +1),
				},
				{
					label: "Zoom Out",
					accelerator: "CommandOrControl+-",
					click: () => zoomStep(BrowserWindow.getAllWindows()[0], -1),
				},
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{ role: "windowMenu" },
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function main() {
	migrateUserData();
	// The credit (owner, 2026-10-27): Mental Tuition is built on Amos
	// Blomqvist's LearnHarness, AGPL-3.0.
	app.setAboutPanelOptions({
		applicationName: PRODUCT_NAME,
		applicationVersion: app.getVersion(),
		credits: "Built on LearnHarness by Amos Blomqvist (github.com/amosblomqvist/learnharness). AGPL-3.0.",
		copyright: "© 2026 Amos Blomqvist (LearnHarness) · © 2026 Youssouf Diallo (Mental Tuition)",
	});
	app.on("window-all-closed", () => {
		// macOS convention: the app stays resident, reactivated from the Dock.
		if (process.platform !== "darwin") app.quit();
	});

	// The child must not outlive us — cover every quit path.
	app.on("before-quit", () => {
		killServer();
		releaseWorkspace(workspace);
	});
	process.on("exit", killServer);
	process.on("SIGHUP", killServer);

	await app.whenReady();

	// Dev mode: point at a running `next dev` server (MT_DEV_URL) — no
	// spawn, no packaging, full HMR. The rest of this shell still applies
	// (guards, menu, single instance).
	const devUrl = process.env.MT_DEV_URL;
	const url = devUrl ?? `http://127.0.0.1:${await freePort()}`;
	if (!devUrl) {
		workspace = readWorkspace() ?? (await pickWorkspace({ first: true }));
		if (!workspace || !(await claimWorkspace(workspace))) {
			app.quit();
			return;
		}
		saveWorkspace(workspace);
		refreshWorkspaceSkills(workspace);
		log(`starting server: ${serverEntry()}`);
		log(`workspace: ${workspace}${fs.existsSync(AUTH_FILE()) ? " · auth.json: present" : " · auth.json: ABSENT (no BYOK keys yet)"}`);
		await startServer(new URL(url).port);
		await waitUntilUp(url);
		log(`server up: ${url}`);
	} else {
		log(`dev mode: ${devUrl}`);
	}

	installMenu();

	// Auto-update (Wave C): wire the updater before the window so the
	// banner channel is live from first paint; the first check and the 24h
	// interval fire after it below. setupAutoUpdater's contract: failures
	// are log lines — this can never block boot.
	setupAutoUpdater();
	ipcMain.on("mt:update-install", () => installUpdateNow());
	// Settings → This computer → Change folder…: pick, move the open-marker,
	// restart the server on the new folder (same port, so the window's origin
	// and storage stay), reload.
	ipcMain.handle("mt:workspace:change", async (event) => {
		if (devUrl) return false; // dev runs on the repo's own folders
		const win = BrowserWindow.fromWebContents(event.sender);
		const next = await pickWorkspace({ first: false });
		if (!next || next === workspace) return false;
		releaseWorkspace(workspace);
		if (!(await claimWorkspace(next))) {
			await claimWorkspace(workspace);
			return false;
		}
		workspace = next;
		saveWorkspace(workspace);
		refreshWorkspaceSkills(workspace);
		await killServer();
		await startServer(new URL(url).port);
		await waitUntilUp(url);
		log(`server restarted on workspace ${workspace}`);
		win?.webContents.reload();
		return true;
	});

	// Sidebar-at-narrow-window (owner, 2026-09-17): the renderer auto-closes
	// the sidebar below SIDEBAR_AUTOCLOSE (928px); opening it again at that
	// width asks the window to widen instead — the layout never has to
	// accommodate a narrow window + open sidebar. Top-left stays fixed, the
	// window grows right. No-op when already wide.
	// The renderer's first paint can race did-finish-load — it asks for
	// the current factor itself (mirrors "mt:zoom" pushes).
	ipcMain.handle("mt:zoom:get", (event) => BrowserWindow.fromWebContents(event.sender)?.webContents.getZoomFactor() ?? 1);
	// The renderer's theme (Mentaljineer skin): the native window controls'
	// symbols must stay readable on the Light ground. No-op on macOS (no overlay).
	ipcMain.on("mt:theme", (event, mode) => {
		if (process.platform === "darwin") return;
		BrowserWindow.fromWebContents(event.sender)?.setTitleBarOverlay(titleBarOverlayFor(mode));
	});
	ipcMain.on("mt:expand-window", (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win) return;
		const { x, y, width, height } = win.getBounds();
		const target = SIDEBAR_AUTOCLOSE;
		if (width < target) win.setBounds({ x, y, width: target, height });
	});
	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow(url);
	});
	createWindow(url);
	log(`window open: ${url}`);
	// First update check AFTER the window exists (the downloaded-banner
	// push needs a listener); dev builds no-op (no autoUpdater).
	if (autoUpdater) {
		checkForUpdates();
		setInterval(() => checkForUpdates(), UPDATE_CHECK_INTERVAL_MS);
	}
}