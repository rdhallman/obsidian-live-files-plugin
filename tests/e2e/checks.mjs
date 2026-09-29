// The end-to-end checks, run by tests/e2e/run.mjs against a real Obsidian driven over the Chrome DevTools
// Protocol. Each check prints PASS/FAIL; the process exits non-zero when any check fails.
import fs from "node:fs";
import { chromium } from "playwright-core";

export async function runChecks(port, VAULT) {
const LOG = `${VAULT}/logs/test-run.md`;
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const append = (n, tag) => fs.appendFileSync(LOG, Array.from({ length: n }, (_, i) => `${tag} ${i}`).join("\n") + "\n");

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = browser.contexts()[0].pages()[0];
// Attached to an existing window (not one Playwright opened), the page is not treated as focused, and a virtual
// display has no window manager to focus it: emulate focus so keystrokes reach the editor.
await (await page.context().newCDPSession(page)).send("Emulation.setFocusEmulationEnabled", { enabled: true });
await page.waitForFunction(() => window.app && app.workspace && app.workspace.layoutReady, null, { timeout: 30000 });

// A fresh vault that ships plugins opens with "Do you trust the author of this vault?": answer it as a user would.
await sleep(1000);
await page.evaluate(() => {
	for (const b of document.querySelectorAll(".modal-container button")) {
		if (/trust/i.test(b.textContent || "")) { b.click(); return; }
	}
});
await sleep(500);
// Trust the vault's plugins (the "restricted mode" switch) and enable ours.
await page.evaluate(async () => {
	document.querySelectorAll(".modal-close-button").forEach((b) => b.click());
	await app.plugins.setEnable(true);
	await app.plugins.enablePluginAndSave("live-files");
});
await sleep(500);
check("plugin loaded", await page.evaluate(() => !!app.plugins.plugins["live-files"]));

// Open the growing log in a tab; make sure the file explorer shows logs/ expanded.
await page.evaluate(async () => {
	const leaf = app.workspace.getLeaf(true);
	await leaf.openFile(app.vault.getAbstractFileByPath("logs/test-run.md"));
	app.workspace.setActiveLeaf(leaf, { focus: true });
	const fe = app.workspace.getLeavesOfType("file-explorer")[0];
	if (fe) { await app.workspace.revealLeaf(fe); fe.view.revealInFolder(app.vault.getAbstractFileByPath("logs/test-run.md")); }
	window.__target = leaf;
	window.__run = (id) => { app.workspace.setActiveLeaf(window.__target, { focus: true }); return app.commands.executeCommandById(id); };
});
await sleep(800);

const scrollState = () => page.evaluate(() => {
	const v = window.__target.view;
	const mode = v.getMode();
	const el = mode === "source" ? v.containerEl.querySelector(".cm-scroller") : v.containerEl.querySelector(".markdown-preview-view");
	const box = el.getBoundingClientRect();
	const lines = [...v.containerEl.querySelectorAll(mode === "source" ? ".cm-line" : ".markdown-preview-section > div")];
	const visible = lines.filter((l) => { const r = l.getBoundingClientRect(); return r.bottom > box.top && r.top < box.bottom && r.height > 0; });
	const lastDocLine = v.editor.getLine(v.editor.lastLine() - 1 >= 0 && v.editor.getLine(v.editor.lastLine()) === "" ? v.editor.lastLine() - 1 : v.editor.lastLine());
	const lastVisible = visible.length ? visible[visible.length - 1].innerText.trim() : null;
	return { mode, top: el.scrollTop, bottomGap: el.scrollHeight - el.scrollTop - el.clientHeight, atEnd: visible.some((l) => l.innerText.trim() === lastDocLine.trim()), lastDocLine, lastVisible };
});

check("header button present", await page.evaluate(() => !!window.__target.view.containerEl.querySelector(".view-action.live-files-tail-action")));

// --- Tail on (command) -> jumps to the end, status bar shows it
await page.evaluate(() => { const v = window.__target.view; v.containerEl.querySelector(".cm-scroller").scrollTop = 0; });
await page.evaluate(() => window.__run("live-files:toggle-tail-follow"));
await sleep(300);
let s = await scrollState();
check("tail on jumps to the end (editing view)", s.atEnd, JSON.stringify(s));
check("button shows on", await page.evaluate(() => !!window.__target.view.containerEl.querySelector(".live-files-tail-action.live-files-tail-on")));
check("status bar shows on", await page.evaluate(() => document.querySelector(".live-files-status")?.textContent === "Tail Follow: on"));

// --- The file grows from outside, in a burst -> view follows the new end
append(60, "burst-a");
await sleep(1500);
s = await scrollState();
check("follows outside writes (editing view)", s.atEnd, JSON.stringify(s));
check("the last written line is in the document", await page.evaluate(() => window.__target.view.editor.getValue().includes("burst-a 59")));

// --- Highlighting: the log changed from outside -> bold in explorer, folder semi-bold, tab bold
const weights = () => page.evaluate(() => {
	const file = document.querySelector('.nav-file-title[data-path="logs/test-run.md"]');
	const folder = document.querySelector('.nav-folder-title[data-path="logs"]');
	const tab = window.__target.tabHeaderEl;
	return {
		file: file ? getComputedStyle(file).fontWeight : null,
		folder: folder ? getComputedStyle(folder).fontWeight : null,
		tabClass: tab ? tab.classList.contains("live-files-changed") : null,
	};
});
let w = await weights();
check("changed file bold in explorer", Number(w.file) >= 700, JSON.stringify(w));
check("parent folder semi-bold", Number(w.folder) >= 600, JSON.stringify(w));
check("tab marked changed", w.tabClass === true, JSON.stringify(w));

// --- Expiry exactly at the end of the window (set to 3 s)
await page.evaluate(async () => { const p = app.plugins.plugins["live-files"]; p.settings.highlightSeconds = 3; await p.saveSettings(); });
append(1, "expiry");
await sleep(1000);
w = await weights();
check("bold during a 3 s window", Number(w.file) >= 700, JSON.stringify(w));
await sleep(2600);
w = await weights();
check("unbolded when the window ends", Number(w.file) < 600 && Number(w.folder) < 600 && w.tabClass === false, JSON.stringify(w));

// --- My own typing is never highlighted
await page.evaluate(async () => {
	const leaf = app.workspace.getLeaf(true);
	await leaf.openFile(app.vault.getAbstractFileByPath("notes/local.md"));
	app.workspace.setActiveLeaf(leaf, { focus: true });
	window.__logLeaf = window.__target; window.__target = leaf;
	const fe = app.workspace.getLeavesOfType("file-explorer")[0];
	fe?.view.revealInFolder(app.vault.getAbstractFileByPath("notes/local.md"));
});
await sleep(500);
// Put the keyboard focus in the note's editor (after the explorer reveal, which takes focus), past any modal.
await page.evaluate(() => {
	document.querySelectorAll(".modal-container .modal-close-button").forEach((b) => b.click());
	app.workspace.setActiveLeaf(window.__target, { focus: true });
	window.__target.view.containerEl.querySelector(".cm-content").setAttribute("data-test-local", "1");
});
await sleep(300);
// A virtual display has no window manager, so the window never gets OS focus: a (forced) page click gives the
// editor the input focus that emulated keystrokes need.
await page.locator('[data-test-local="1"]').click({ force: true });
await page.keyboard.press("Control+End");
await page.keyboard.type("typed by me ");
const inEditor = await page.evaluate(() => window.__target.view.editor.getValue().includes("typed by me"));
check("keystrokes reached the editor (test setup)", inEditor);
await sleep(3500); // Obsidian saves ~2 s after typing
const localWeight = await page.evaluate(() => { const el = document.querySelector('.nav-file-title[data-path="notes/local.md"]'); return el ? getComputedStyle(el).fontWeight : "no-el"; });
const saved = fs.readFileSync(`${VAULT}/notes/local.md`, "utf8").includes("typed by me");
check("own typing saved but not highlighted", saved && Number(localWeight) < 600, `saved=${saved} weight=${localWeight}`);
// ...while an outside write to the same note is
await sleep(3000); // past the local-edit grace
fs.appendFileSync(`${VAULT}/notes/local.md`, "\nwritten from outside\n");
await sleep(1500);
const localWeight2 = await page.evaluate(() => getComputedStyle(document.querySelector('.nav-file-title[data-path="notes/local.md"]')).fontWeight);
check("outside write to a note I edited is highlighted", Number(localWeight2) >= 700, `weight=${localWeight2}`);

// --- Tail off leaves the scroll alone
await page.evaluate(() => {
	window.__target = window.__logLeaf;
	app.workspace.setActiveLeaf(window.__target, { focus: true });
});
await sleep(300);
await page.evaluate(() => window.__run("live-files:toggle-tail-follow")); // off
await page.evaluate(() => { window.__target.view.containerEl.querySelector(".cm-scroller").scrollTop = 200; });
await sleep(300);
const before = (await scrollState()).top;
append(40, "burst-b");
await sleep(1500);
s = await scrollState();
check("tail off: outside writes do not move the view", Math.abs(s.top - before) < 5, `before=${before} after=${s.top}`);
check("status bar hidden when off", await page.evaluate(() => !document.querySelector(".live-files-status")?.textContent));

// --- Reading view follows too
await page.evaluate(async () => {
	const leaf = window.__target;
	await leaf.setViewState({ ...leaf.getViewState(), state: { ...leaf.getViewState().state, mode: "preview" } });
});
await sleep(800);
await page.evaluate(() => window.__run("live-files:toggle-tail-follow")); // on
await sleep(800);
append(80, "burst-c");
await sleep(2500);
s = await scrollState();
check("follows outside writes (reading view)", s.mode === "preview" && s.bottomGap < 450, JSON.stringify({mode: s.mode, top: s.top, bottomGap: s.bottomGap}));
check("reading view shows the newest line", await page.evaluate(() => window.__target.view.containerEl.querySelector(".markdown-preview-view").innerText.includes("burst-c 79")));

// --- Optional: scrolling up by hand switches tail off
await page.evaluate(async () => {
	const leaf = window.__target;
	await leaf.setViewState({ ...leaf.getViewState(), state: { ...leaf.getViewState().state, mode: "source" } });
	const p = app.plugins.plugins["live-files"]; p.settings.stopTailOnScrollUp = true; await p.saveSettings();
});
await sleep(1000);
await page.evaluate(() => { window.__target.view.containerEl.querySelector(".cm-scroller").scrollTop = 0; });
await sleep(500);
check("scroll up switches tail off (when enabled)", await page.evaluate(() => !window.__target.view.containerEl.querySelector(".live-files-tail-action.live-files-tail-on")));

// --- Context menu entry exists
const menuHasItem = await page.evaluate(() => {
	const leaf = window.__target;
	const titles = [];
	const fakeMenu = { addItem(cb) { const item = { setTitle(t) { titles.push(t); return item; }, setIcon() { return item; }, onClick() { return item; }, setSection() { return item; } }; cb(item); return fakeMenu; } };
	app.workspace.trigger("file-menu", fakeMenu, leaf.view.file, "tab-header", leaf);
	return titles;
});
check("tab context menu offers Tail Follow", menuHasItem.includes("Tail Follow"), JSON.stringify(menuHasItem));

// --- Disabling the plugin cleans up
await page.evaluate(async () => { await app.plugins.disablePluginAndSave("live-files"); });
await sleep(500);
check("disable removes buttons and highlight styles", await page.evaluate(() => !document.querySelector(".live-files-tail-action") && !document.getElementById("live-files-highlights")));

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
await browser.close();
return failed;
}
