import {
	App,
	MarkdownView,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
	WorkspaceLeaf,
} from "obsidian";
import { EditorView, ViewUpdate } from "@codemirror/view";

import { ActivityTracker, compileGlobs, matchesAny, parentFolders } from "./activity";

interface LiveFilesSettings {
	/** How long an outside change keeps a file highlighted. */
	highlightSeconds: number;
	highlightExplorer: boolean;
	highlightFolders: boolean;
	highlightTabs: boolean;
	/** Turn Tail Follow off when the user scrolls up in a followed tab. */
	stopTailOnScrollUp: boolean;
	/** Glob patterns (one per line) of files whose tabs start with Tail Follow on. */
	autoTailPatterns: string;
}

const DEFAULT_SETTINGS: LiveFilesSettings = {
	highlightSeconds: 60,
	highlightExplorer: true,
	highlightFolders: true,
	highlightTabs: true,
	stopTailOnScrollUp: false,
	autoTailPatterns: "",
};

const ICON = "arrow-down-to-line";
const TAB_CHANGED_CLASS = "live-files-changed";
const ACTION_ACTIVE_CLASS = "live-files-tail-on";
/** A scroll event this soon after our own scroll is ours, not the user's. */
const OWN_SCROLL_MS = 400;
/** Distance from the bottom (px) below which a user scroll counts as "scrolled up". */
const SCROLLED_UP_PX = 48;
/** Reading view re-renders a moment after the file changes; scroll after that. */
const PREVIEW_SETTLE_MS = 120;

export default class LiveFilesPlugin extends Plugin {
	settings: LiveFilesSettings = DEFAULT_SETTINGS;
	private tracker = new ActivityTracker(DEFAULT_SETTINGS.highlightSeconds * 1000);
	private styleEl: HTMLStyleElement | null = null;
	private statusEl: HTMLElement | null = null;
	private expiryTimer: number | null = null;

	/** Tabs with Tail Follow on. */
	private tailed = new Set<WorkspaceLeaf>();
	/** The header button we added to each Markdown tab. */
	private actions = new Map<WorkspaceLeaf, HTMLElement>();
	/** The file each tab had when auto-tail last looked at it (so auto-tail applies once per file opened). */
	private autoTailSeen = new Map<WorkspaceLeaf, string>();
	private lastOwnScroll = new Map<WorkspaceLeaf, number>();
	private scrollListenerAttached = new WeakSet<HTMLElement>();
	private autoTailGlobs: RegExp[] = [];

	/** Scrolls requested since the last animation frame (coalesces bursts of writes into one scroll). */
	private pendingScroll = new Set<WorkspaceLeaf>();
	private frame: number | null = null;
	private previewTimer: number | null = null;
	private pendingPreview = new Set<WorkspaceLeaf>();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.tracker.setWindow(this.settings.highlightSeconds * 1000);
		this.autoTailGlobs = compileGlobs(this.settings.autoTailPatterns);

		this.styleEl = document.head.createEl("style", { attr: { id: "live-files-highlights" } });
		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("live-files-status");
		this.addSettingTab(new LiveFilesSettingTab(this.app, this));

		this.addCommand({
			id: "toggle-tail-follow",
			name: "Toggle Tail Follow for this tab",
			checkCallback: (checking) => {
				const leaf = this.activeMarkdownLeaf();
				if (!leaf) return false;
				if (!checking) this.toggleTail(leaf);
				return true;
			},
		});

		// Right-click on the tab header or the file, and inside the note.
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, _file, _source, leaf) => {
				if (!leaf || !(leaf.view instanceof MarkdownView)) return;
				const on = this.tailed.has(leaf);
				menu.addItem((item) =>
					item
						.setTitle(on ? "Stop Tail Follow" : "Tail Follow")
						.setIcon(ICON)
						.onClick(() => this.toggleTail(leaf)),
				);
			}),
		);
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, _editor, info) => {
				if (!(info instanceof MarkdownView)) return;
				const leaf = info.leaf;
				const on = this.tailed.has(leaf);
				menu.addItem((item) =>
					item
						.setTitle(on ? "Stop Tail Follow" : "Tail Follow")
						.setIcon(ICON)
						.onClick(() => this.toggleTail(leaf)),
				);
			}),
		);

		// The editor tells us exactly when a document's content changed (after Obsidian reloaded it).
		this.registerEditorExtension(EditorView.updateListener.of((update) => this.onEditorUpdate(update)));

		this.app.workspace.onLayoutReady(() => {
			// Registered only once the vault is loaded: at startup Obsidian reports every file as "created".
			this.registerEvent(this.app.vault.on("modify", (file) => this.onFileChanged(file)));
			this.registerEvent(
				this.app.vault.on("create", (file) => {
					// A note created inside Obsidian starts empty; one written by another program has content.
					if (file instanceof TFile && file.stat.size > 0) this.onFileChanged(file);
				}),
			);
			this.registerEvent(
				this.app.vault.on("rename", (file, oldPath) => {
					this.tracker.rename(oldPath, file.path);
					this.render();
				}),
			);
			this.registerEvent(
				this.app.vault.on("delete", (file) => {
					this.tracker.remove(file.path);
					this.render();
					this.scheduleExpiry();
				}),
			);
			this.registerEvent(this.app.workspace.on("layout-change", () => this.syncLeaves()));
			this.registerEvent(this.app.workspace.on("file-open", () => this.syncLeaves()));
			this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.updateStatus()));
			this.syncLeaves();
		});
	}

	onunload(): void {
		if (this.expiryTimer !== null) window.clearTimeout(this.expiryTimer);
		if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		for (const el of this.actions.values()) el.remove();
		this.actions.clear();
		for (const leaf of this.markdownLeaves()) this.tabHeader(leaf)?.removeClass(TAB_CHANGED_CLASS);
		this.styleEl?.remove();
		this.tailed.clear();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.tracker.setWindow(this.settings.highlightSeconds * 1000);
		this.autoTailGlobs = compileGlobs(this.settings.autoTailPatterns);
		this.render();
	}

	// ---------------------------------------------------------------- Tail Follow

	toggleTail(leaf: WorkspaceLeaf): void {
		this.setTail(leaf, !this.tailed.has(leaf));
	}

	setTail(leaf: WorkspaceLeaf, on: boolean): void {
		if (on) {
			this.tailed.add(leaf);
			this.attachScrollListener(leaf);
			this.scrollToEnd(leaf); // switching on jumps to the end straight away
		} else {
			this.tailed.delete(leaf);
		}
		this.actions.get(leaf)?.toggleClass(ACTION_ACTIVE_CLASS, on);
		this.actions.get(leaf)?.setAttribute("aria-label", on ? "Stop Tail Follow" : "Tail Follow");
		this.updateStatus();
	}

	private onEditorUpdate(update: ViewUpdate): void {
		if (!update.docChanged) return;
		const leaf = this.leafForEditor(update.view);
		if (!leaf) return;
		const file = (leaf.view as MarkdownView).file;
		const typed = update.transactions.some(
			(tr) =>
				tr.isUserEvent("input") ||
				tr.isUserEvent("delete") ||
				tr.isUserEvent("move") ||
				tr.isUserEvent("undo") ||
				tr.isUserEvent("redo"),
		);
		if (typed) {
			// The user's own edit: never counts as an outside change, and never yanks the view to the end.
			if (file) this.tracker.noteLocalEdit(file.path, Date.now());
			return;
		}
		if (this.tailed.has(leaf)) this.scheduleScroll(leaf);
	}

	private onFileChanged(file: TAbstractFile): void {
		if (!(file instanceof TFile)) return;
		if (this.tracker.noteModify(file.path, Date.now())) {
			this.render();
			this.scheduleExpiry();
		}
		// Reading view has no editor to notify us: follow on the file event once the view has re-rendered.
		for (const leaf of this.tailed) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === file.path && view.getMode() === "preview") {
				this.schedulePreviewScroll(leaf);
			}
		}
	}

	/** At most one scroll per animation frame, however many writes arrived. */
	private scheduleScroll(leaf: WorkspaceLeaf): void {
		this.pendingScroll.add(leaf);
		if (this.frame !== null) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = null;
			const leaves = [...this.pendingScroll];
			this.pendingScroll.clear();
			for (const l of leaves) if (this.tailed.has(l)) this.scrollToEnd(l);
		});
	}

	private schedulePreviewScroll(leaf: WorkspaceLeaf): void {
		this.pendingPreview.add(leaf);
		if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
		this.previewTimer = window.setTimeout(() => {
			this.previewTimer = null;
			const leaves = [...this.pendingPreview];
			this.pendingPreview.clear();
			for (const l of leaves) if (this.tailed.has(l)) this.scheduleScroll(l);
		}, PREVIEW_SETTLE_MS);
	}

	private scrollToEnd(leaf: WorkspaceLeaf): void {
		const view = leaf.view;
		if (!(view instanceof MarkdownView)) return;
		this.lastOwnScroll.set(leaf, Date.now());
		if (view.getMode() === "source") {
			const editor = view.editor;
			const last = editor.lastLine();
			const end = { line: last, ch: editor.getLine(last).length };
			editor.scrollIntoView({ from: end, to: end }, false);
		} else {
			// Reading view renders long notes in sections; its full height is only known once the last section is
			// rendered, so scroll its container to the bottom, and once more on the next frame.
			// previewMode.containerEl is a wrapper (.markdown-reading-view); the element that scrolls is inside it.
			const wrapper = view.previewMode.containerEl;
			const scroller = wrapper.querySelector<HTMLElement>(".markdown-preview-view") ?? wrapper;
			scroller.scrollTop = scroller.scrollHeight;
			window.requestAnimationFrame(() => {
				this.lastOwnScroll.set(leaf, Date.now());
				scroller.scrollTop = scroller.scrollHeight;
			});
		}
	}

	/** Optional: scrolling up by hand turns Tail Follow off for that tab. */
	private attachScrollListener(leaf: WorkspaceLeaf): void {
		const el = leaf.view.containerEl;
		if (this.scrollListenerAttached.has(el)) return;
		this.scrollListenerAttached.add(el);
		this.registerDomEvent(
			el,
			"scroll",
			(evt) => {
				if (!this.settings.stopTailOnScrollUp || !this.tailed.has(leaf)) return;
				if (Date.now() - (this.lastOwnScroll.get(leaf) ?? 0) < OWN_SCROLL_MS) return;
				const target = evt.target as HTMLElement;
				if (target.scrollTop + target.clientHeight < target.scrollHeight - SCROLLED_UP_PX) {
					this.setTail(leaf, false);
				}
			},
			{ capture: true, passive: true },
		);
	}

	// ---------------------------------------------------------------- tabs, buttons, status

	/** Adds the header button to new Markdown tabs, forgets closed ones, applies auto-tail. */
	private syncLeaves(): void {
		const leaves = new Set(this.markdownLeaves());
		for (const leaf of leaves) {
			const view = leaf.view as MarkdownView;
			let action = this.actions.get(leaf);
			if (!action || !action.isConnected) {
				action = view.addAction(ICON, "Tail Follow", () => this.toggleTail(leaf));
				action.addClass("live-files-tail-action");
				action.toggleClass(ACTION_ACTIVE_CLASS, this.tailed.has(leaf));
				this.actions.set(leaf, action);
			}
			const path = view.file?.path;
			if (path && this.autoTailSeen.get(leaf) !== path) {
				this.autoTailSeen.set(leaf, path);
				if (matchesAny(path, this.autoTailGlobs) && !this.tailed.has(leaf)) this.setTail(leaf, true);
			}
		}
		for (const leaf of [...this.actions.keys()]) {
			if (!leaves.has(leaf)) {
				this.actions.get(leaf)?.remove();
				this.actions.delete(leaf);
				this.tailed.delete(leaf);
				this.autoTailSeen.delete(leaf);
				this.lastOwnScroll.delete(leaf);
			}
		}
		this.renderTabs();
		this.updateStatus();
	}

	private updateStatus(): void {
		if (!this.statusEl) return;
		const leaf = this.activeMarkdownLeaf();
		const on = !!leaf && this.tailed.has(leaf);
		this.statusEl.setText(on ? "Tail Follow: on" : "");
		this.statusEl.toggle(on);
	}

	// ---------------------------------------------------------------- highlighting outside changes

	/** One stylesheet rule per highlighted path (file explorer), plus a class on open tabs. */
	render(): void {
		if (!this.styleEl) return;
		const paths = this.tracker.active();
		const rules: string[] = [];
		if (this.settings.highlightExplorer) {
			for (const p of paths) rules.push(`.nav-file-title[data-path="${CSS.escape(p)}"]{font-weight:var(--font-bold,700);}`);
		}
		if (this.settings.highlightFolders) {
			for (const f of parentFolders(paths)) {
				rules.push(`.nav-folder-title[data-path="${CSS.escape(f)}"]{font-weight:var(--font-semibold,600);}`);
			}
		}
		this.styleEl.textContent = rules.join("\n");
		this.renderTabs();
	}

	private renderTabs(): void {
		for (const leaf of this.markdownLeaves()) {
			const path = (leaf.view as MarkdownView).file?.path;
			const on = this.settings.highlightTabs && !!path && this.tracker.isActive(path);
			this.tabHeader(leaf)?.toggleClass(TAB_CHANGED_CLASS, on);
		}
	}

	/** One timer, set for the earliest expiry; each highlight is removed the moment its window ends. */
	private scheduleExpiry(): void {
		if (this.expiryTimer !== null) window.clearTimeout(this.expiryTimer);
		this.expiryTimer = null;
		const next = this.tracker.nextExpiry();
		if (next === null) return;
		this.expiryTimer = window.setTimeout(() => {
			this.expiryTimer = null;
			if (this.tracker.expire(Date.now()).length > 0) this.render();
			this.scheduleExpiry();
		}, Math.max(0, next - Date.now()));
	}

	// ---------------------------------------------------------------- helpers

	private markdownLeaves(): WorkspaceLeaf[] {
		return this.app.workspace.getLeavesOfType("markdown");
	}

	private activeMarkdownLeaf(): WorkspaceLeaf | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		return view ? view.leaf : null;
	}

	/** The tab whose view contains this CodeMirror editor (matched by DOM, no internal fields). */
	private leafForEditor(editorView: EditorView): WorkspaceLeaf | null {
		for (const leaf of this.markdownLeaves()) {
			if (leaf.view.containerEl.contains(editorView.dom)) return leaf;
		}
		return null;
	}

	/** The tab's header element. Not in Obsidian's public typings; used only to bold tab titles, and guarded. */
	private tabHeader(leaf: WorkspaceLeaf): HTMLElement | null {
		const el = (leaf as unknown as { tabHeaderEl?: unknown }).tabHeaderEl;
		return el instanceof HTMLElement ? el : null;
	}
}

class LiveFilesSettingTab extends PluginSettingTab {
	private plugin: LiveFilesPlugin;

	constructor(app: App, plugin: LiveFilesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Tail Follow").setHeading();

		new Setting(containerEl)
			.setName("Stop following when I scroll up")
			.setDesc("Off: Tail Follow stays on until you switch it off. On: scrolling up in a followed tab also switches it off.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.stopTailOnScrollUp).onChange(async (v) => {
					this.plugin.settings.stopTailOnScrollUp = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Follow these files automatically")
			.setDesc("Glob patterns, one per line: tabs opening a matching file start with Tail Follow on. Example: *-run.md")
			.addTextArea((t) =>
				t
					.setPlaceholder("*-run.md")
					.setValue(this.plugin.settings.autoTailPatterns)
					.onChange(async (v) => {
						this.plugin.settings.autoTailPatterns = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Changed files").setHeading();

		new Setting(containerEl)
			.setName("Highlight for (seconds)")
			.setDesc("How long a file changed outside Obsidian stays bold. Your own edits in Obsidian are never highlighted.")
			.addText((t) =>
				t.setValue(String(this.plugin.settings.highlightSeconds)).onChange(async (v) => {
					const n = Number.parseInt(v, 10);
					if (!Number.isFinite(n) || n < 1) return;
					this.plugin.settings.highlightSeconds = n;
					await this.plugin.saveSettings();
				}),
			);

		const toggle = (name: string, desc: string, key: "highlightExplorer" | "highlightFolders" | "highlightTabs") =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addToggle((t) =>
					t.setValue(this.plugin.settings[key]).onChange(async (v) => {
						this.plugin.settings[key] = v;
						await this.plugin.saveSettings();
					}),
				);
		toggle("In the file explorer", "Bold file names.", "highlightExplorer");
		toggle("On folders", "Semi-bold on the folders above a changed file, so changes inside collapsed folders show.", "highlightFolders");
		toggle("On tabs", "Bold tab titles of changed files.", "highlightTabs");
	}
}
