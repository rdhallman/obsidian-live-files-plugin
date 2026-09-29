/**
 * Which files changed outside Obsidian recently, and when each highlight expires.
 *
 * Pure logic (no Obsidian imports) so it can be unit-tested. The plugin feeds it events and asks it what to
 * highlight; it never polls. "Outside" means: not within `localGraceMs` of the user typing in that file
 * (Obsidian saves a typed-in note a moment after the last keystroke, and that save must not count).
 */
export class ActivityTracker {
	private windowMs: number;
	private readonly localGraceMs: number;
	/** path -> time its highlight expires */
	private readonly expiries = new Map<string, number>();
	/** path -> time of the user's last local edit in that file */
	private readonly localEdits = new Map<string, number>();

	constructor(windowMs: number, localGraceMs = 5000) {
		this.windowMs = windowMs;
		this.localGraceMs = localGraceMs;
	}

	setWindow(windowMs: number): void {
		this.windowMs = windowMs;
	}

	/** The user typed (or pasted, deleted, undid...) in this file. */
	noteLocalEdit(path: string, now: number): void {
		this.localEdits.set(path, now);
		if (this.localEdits.size > 500) this.pruneLocalEdits(now);
	}

	/** The file changed on disk. Returns true when it counts as an outside change (and is now highlighted). */
	noteModify(path: string, now: number): boolean {
		const local = this.localEdits.get(path);
		if (local !== undefined && now - local <= this.localGraceMs) return false;
		this.expiries.set(path, now + this.windowMs);
		return true;
	}

	/** Drops highlights whose window has passed; returns the paths that were dropped. */
	expire(now: number): string[] {
		const dropped: string[] = [];
		for (const [path, until] of this.expiries) {
			if (until <= now) {
				this.expiries.delete(path);
				dropped.push(path);
			}
		}
		return dropped;
	}

	/** When the next highlight expires (ms since epoch), or null when nothing is highlighted. */
	nextExpiry(): number | null {
		let next: number | null = null;
		for (const until of this.expiries.values()) if (next === null || until < next) next = until;
		return next;
	}

	/** Paths highlighted right now. */
	active(): string[] {
		return [...this.expiries.keys()];
	}

	isActive(path: string): boolean {
		return this.expiries.has(path);
	}

	rename(oldPath: string, newPath: string): void {
		const until = this.expiries.get(oldPath);
		if (until !== undefined) {
			this.expiries.delete(oldPath);
			this.expiries.set(newPath, until);
		}
		const local = this.localEdits.get(oldPath);
		if (local !== undefined) {
			this.localEdits.delete(oldPath);
			this.localEdits.set(newPath, local);
		}
	}

	remove(path: string): void {
		this.expiries.delete(path);
		this.localEdits.delete(path);
	}

	clear(): void {
		this.expiries.clear();
		this.localEdits.clear();
	}

	private pruneLocalEdits(now: number): void {
		for (const [path, at] of this.localEdits) if (now - at > this.localGraceMs) this.localEdits.delete(path);
	}
}

/** Every folder above the given file paths ("a/b/c.md" -> "a", "a/b"). */
export function parentFolders(paths: Iterable<string>): string[] {
	const folders = new Set<string>();
	for (const path of paths) {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
	}
	return [...folders];
}

/**
 * Glob patterns, one per line or comma-separated: `*` matches within a folder name, `**` across folders, `?` one
 * character. A pattern without a `/` matches the file name anywhere in the vault ("*-run.md").
 */
export function compileGlobs(patterns: string): RegExp[] {
	return patterns
		.split(/[\n,]/)
		.map((p) => p.trim())
		.filter((p) => p.length > 0)
		.map((p) => {
			let re = "";
			for (let i = 0; i < p.length; i++) {
				const c = p[i];
				if (c === "*" && p[i + 1] === "*") {
					re += ".*";
					i++;
					if (p[i + 1] === "/") i++;
				} else if (c === "*") re += "[^/]*";
				else if (c === "?") re += "[^/]";
				else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
			}
			return new RegExp(p.includes("/") ? `^${re}$` : `(^|/)${re}$`);
		});
}

export function matchesAny(path: string, globs: RegExp[]): boolean {
	return globs.some((g) => g.test(path));
}
