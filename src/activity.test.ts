// node --test src/*.test.ts (Node strips the types itself; no build step)
import { test } from "node:test";
import assert from "node:assert/strict";

import { ActivityTracker, compileGlobs, matchesAny, parentFolders } from "./activity.ts";

test("an outside change is highlighted for the window, then expires exactly at its end", () => {
	const t = new ActivityTracker(60_000);
	assert.equal(t.noteModify("logs/run.md", 1_000), true);
	assert.deepEqual(t.active(), ["logs/run.md"]);
	assert.equal(t.nextExpiry(), 61_000);
	assert.deepEqual(t.expire(60_999), []);
	assert.deepEqual(t.expire(61_000), ["logs/run.md"]);
	assert.deepEqual(t.active(), []);
	assert.equal(t.nextExpiry(), null);
});

test("another change extends the highlight", () => {
	const t = new ActivityTracker(60_000);
	t.noteModify("a.md", 0);
	t.noteModify("a.md", 30_000);
	assert.equal(t.nextExpiry(), 90_000);
	assert.deepEqual(t.expire(60_000), []);
	assert.deepEqual(t.expire(90_000), ["a.md"]);
});

test("the save that follows the user's own typing is not an outside change", () => {
	const t = new ActivityTracker(60_000, 5_000);
	t.noteLocalEdit("note.md", 10_000);
	assert.equal(t.noteModify("note.md", 12_000), false, "Obsidian's save 2 s after typing");
	assert.deepEqual(t.active(), []);
	assert.equal(t.noteModify("note.md", 16_000), true, "a change long after the last keystroke is outside");
	assert.equal(t.noteModify("other.md", 12_000), true, "typing in one file does not hide changes to another");
});

test("the earliest expiry is always next, across several files", () => {
	const t = new ActivityTracker(60_000);
	t.noteModify("b.md", 5_000);
	t.noteModify("a.md", 1_000);
	assert.equal(t.nextExpiry(), 61_000);
	t.expire(61_000);
	assert.equal(t.nextExpiry(), 65_000);
});

test("rename moves a highlight; remove drops it", () => {
	const t = new ActivityTracker(60_000);
	t.noteModify("old.md", 0);
	t.rename("old.md", "new.md");
	assert.deepEqual(t.active(), ["new.md"]);
	t.remove("new.md");
	assert.deepEqual(t.active(), []);
});

test("a new window applies to later changes", () => {
	const t = new ActivityTracker(60_000);
	t.setWindow(10_000);
	t.noteModify("a.md", 0);
	assert.equal(t.nextExpiry(), 10_000);
});

test("parentFolders lists every folder above the files", () => {
	assert.deepEqual(parentFolders(["a/b/c.md", "a/d.md", "top.md"]).sort(), ["a", "a/b"]);
});

test("globs: a pattern without a slash matches the file name anywhere", () => {
	const g = compileGlobs("*-run.md");
	assert.ok(matchesAny("ondeck/plan005-chaperone-mode-run.md", g));
	assert.ok(matchesAny("x-run.md", g));
	assert.ok(!matchesAny("ondeck/plan005-chaperone-mode.md", g));
	assert.ok(!matchesAny("x-run.md.bak", g));
});

test("globs: folders, ** and several patterns", () => {
	const g = compileGlobs("logs/*.md, **/live/*.txt\n  notes/?.md ");
	assert.ok(matchesAny("logs/a.md", g));
	assert.ok(!matchesAny("logs/sub/a.md", g), "* stays within one folder");
	assert.ok(matchesAny("x/y/live/z.txt", g));
	assert.ok(matchesAny("live/z.txt", g), "**/ also matches no folder");
	assert.ok(matchesAny("notes/a.md", g));
	assert.ok(!matchesAny("notes/ab.md", g));
	assert.deepEqual(compileGlobs("  \n , "), []);
});

test("globs: regex characters in names are literal", () => {
	const g = compileGlobs("a+b (1).md");
	assert.ok(matchesAny("a+b (1).md", g));
	assert.ok(!matchesAny("aab 1.md", g));
});
