// End-to-end test in a real Obsidian (Linux): `npm run test:e2e`.
//
// Builds nothing itself (the npm script builds first). Creates a throwaway vault and Obsidian settings folder,
// starts a private virtual display (Xvfb) and a separate Obsidian with remote debugging, runs tests/e2e/checks.mjs,
// then stops everything and deletes the temporary files. Your own Obsidian and vaults are never touched: Obsidian
// only shares state between instances that use the same settings folder.
//
// Needs: Xvfb, and Obsidian's Electron + app.asar. Defaults fit Arch Linux's `obsidian` package; override with
//   OBSIDIAN_ELECTRON=/path/to/electron OBSIDIAN_ASAR=/path/to/app.asar npm run test:e2e
// (For an AppImage: run it with --appimage-extract and point both at the extracted files.)
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runChecks } from "./checks.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ELECTRON = process.env.OBSIDIAN_ELECTRON || "/usr/bin/electron43";
const ASAR = process.env.OBSIDIAN_ASAR || "/usr/lib/obsidian/app.asar";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const [what, p] of [["Obsidian's Electron", ELECTRON], ["Obsidian's app.asar", ASAR], ["main.js (run npm run build)", path.join(ROOT, "main.js")]]) {
	if (!fs.existsSync(p)) {
		console.error(`missing ${what}: ${p}`);
		process.exit(2);
	}
}

const freePort = () => new Promise((resolve) => {
	const srv = net.createServer();
	srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "live-files-e2e-"));
const vault = path.join(tmp, "vault");
const userData = path.join(tmp, "userdata");
const pluginDir = path.join(vault, ".obsidian", "plugins", "live-files");
fs.mkdirSync(pluginDir, { recursive: true });
fs.mkdirSync(path.join(vault, "logs"));
fs.mkdirSync(path.join(vault, "notes"));
fs.mkdirSync(userData);
for (const f of ["main.js", "manifest.json", "styles.css"]) fs.copyFileSync(path.join(ROOT, f), path.join(pluginDir, f));
fs.writeFileSync(path.join(vault, ".obsidian", "community-plugins.json"), '["live-files"]');
fs.writeFileSync(path.join(userData, "obsidian.json"), JSON.stringify({ vaults: { e2evault000000001: { path: vault, ts: Date.now(), open: true } } }));
fs.writeFileSync(path.join(vault, "logs", "test-run.md"), "# Test run log\n\n" + Array.from({ length: 199 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
fs.writeFileSync(path.join(vault, "notes", "local.md"), "# Local note\n\nText.\n");

let display = 900 + Math.floor(Math.random() * 90);
while (fs.existsSync(`/tmp/.X11-unix/X${display}`)) display++;
const port = await freePort();

const procs = [];
const cleanup = () => {
	for (const p of procs.reverse()) { try { process.kill(-p.pid, "SIGTERM"); } catch { /* gone */ } }
	fs.rmSync(tmp, { recursive: true, force: true });
};
process.on("SIGINT", () => { cleanup(); process.exit(130); });

let failed = 1;
try {
	procs.push(spawn("Xvfb", [`:${display}`, "-screen", "0", "1400x900x24", "-nolisten", "tcp"], { detached: true, stdio: "ignore" }));
	for (let i = 0; i < 50 && !fs.existsSync(`/tmp/.X11-unix/X${display}`); i++) await sleep(100);

	const env = { ...process.env, DISPLAY: `:${display}`, XDG_SESSION_TYPE: "x11" };
	delete env.WAYLAND_DISPLAY;
	delete env.XDG_CURRENT_DESKTOP;
	procs.push(spawn(ELECTRON, [ASAR, "--ozone-platform=x11", `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], { detached: true, stdio: "ignore", env }));

	let up = false;
	for (let i = 0; i < 60 && !up; i++) {
		try { up = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { await sleep(500); }
	}
	if (!up) throw new Error("Obsidian did not start (no remote debugging endpoint)");
	failed = await runChecks(port, vault);
} catch (err) {
	console.error(err);
	failed = 1;
} finally {
	cleanup();
}
process.exit(failed ? 1 : 0);
