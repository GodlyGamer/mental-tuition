/*
 * Preload (2026-09-17, narrow-window wave): the ONLY bridge between the
 * sandboxed renderer and the main process. contextIsolation + sandbox are
 * on (electron/main.cjs), so this file is the renderer's entire access to
 * Electron — keep it a minimal, explicit API surface.
 *
 *   window.mt.platform — read-only OS identity for native window-control
 *   gutters (darwin: left traffic lights; win32/linux: right overlay).
 *
 *   window.mt.setTheme(mode) — the Mentaljineer theme, so the native
 *   window controls (Windows/Linux) keep legible symbols on its ground.
 *
 *   window.mt.expandWindow() — widen the window to the sidebar auto-close
 *   threshold (928px) when the sidebar is opened below it. The main
 *   process clamps: no-op if the window is already wide enough.
 *
 *   window.mt.onZoom(cb) / window.mt.getZoom() — the zoom truth (owner
 *   round 7, 2026-10-05): every ⌘±/⌘0 change arrives as "mt:zoom" with
 *   the new factor; getZoom covers the first-paint race. The renderer
 *   publishes it as --mt-zoom so physical-constant lengths (the traffic-
 *   light gutter) can divide by it.
 *
 *   window.mt.onUpdateStatus(cb) / window.mt.installUpdate() — the
 *   auto-update channel (Wave C, 2026-10-10): "mt:update-status" pushes
 *   {status:"downloaded", version} once an update is staged; installUpdate
 *   asks main to kill the server and quit-and-install. Browser builds:
 *   both absent, the banner never renders.
 *
 * Channel names are mirrored in electron/main.cjs — keep them in sync.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mt", {
	platform: process.platform,
	expandWindow: () => ipcRenderer.send("mt:expand-window"),
	setTheme: (mode) => ipcRenderer.send("mt:theme", mode),
	onZoom: (cb) => {
		const listener = (_event, factor) => cb(factor);
		ipcRenderer.on("mt:zoom", listener);
		return () => ipcRenderer.removeListener("mt:zoom", listener);
	},
	getZoom: () => ipcRenderer.invoke("mt:zoom:get"),
	onUpdateStatus: (cb) => {
		const listener = (_event, status) => cb(status);
		ipcRenderer.on("mt:update-status", listener);
		return () => ipcRenderer.removeListener("mt:update-status", listener);
	},
	installUpdate: () => ipcRenderer.send("mt:update-install"),
	// The synced workspace folder (personal fork, 2026-10-24): a folder picker
	// in the shell, which restarts the server on the new folder and reloads.
	changeWorkspace: () => ipcRenderer.invoke("mt:workspace:change"),
});
