# Live Files

An [Obsidian](https://obsidian.md) plugin for notes that other programs write to: logs, reports, anything a script, agent or build keeps appending to.

- **Tail Follow**: keep a note scrolled to its end while it grows, like `tail -f`. You switch it on and off per tab.
- **Changed files**: files changed *outside* Obsidian in the last minute are shown in **bold**, and go back to normal as soon as that window passes.

## Tail Follow

Switch it on for a tab in any of these ways:

- the **Tail Follow** button in the note's header (next to the reading/editing view button; accented while on),
- right-click the tab or inside the note → **Tail Follow** / **Stop Tail Follow**,
- the command palette: **Live Files: Toggle Tail Follow for this tab** (you can bind a hotkey).

Switching it on jumps to the end; from then on the tab follows every change written to the file, in editing and reading view. Switching it off leaves the view where it is. The status bar shows **Tail Follow: on** while the active tab follows.

Settings:

- **Stop following when I scroll up** (off by default): scrolling up in a followed tab also switches it off.
- **Follow these files automatically**: glob patterns, one per line (e.g. `*-run.md`, `logs/*.md`); tabs that open a matching file start with Tail Follow on.

## Changed files

When a file changes on disk and the change did not come from you typing in Obsidian (another program, a sync, a script), its name is shown in bold:

- in the **file explorer**,
- on its **folders**, in semi-bold, so changes inside collapsed folders are visible too,
- on its **tab**, if it is open.

Each highlight lasts **60 seconds** by default (configurable) after the file's last outside change, and is removed the moment that window ends. Each part (explorer, folders, tabs) can be switched off in the settings.

Your own edits are never highlighted: a save that follows your typing in that file within a few seconds does not count. Changes made through Obsidian without typing in the editor (for example the properties panel or another plugin) do count as outside changes.

## How it works (and why it stays light)

Nothing polls or loops. Obsidian already watches the vault for changes; the plugin listens to those events and to the editor's own "document changed" notification, and:

- scrolls a followed tab **once** per change, merging bursts of writes into at most one scroll per screen refresh,
- keeps **one** timer for the earliest highlight to expire, whatever the number of highlighted files.

Tabs that are not followed cost one check per change; highlighting is a stylesheet rule per changed path (it uses the file explorer's `data-path` attributes, no Obsidian internals). The one non-public detail used is a tab's header element, to bold tab titles; it is guarded, so if Obsidian changes it, only tab bolding stops.

## Install

From Obsidian: **Settings → Community plugins → Browse → "Live Files"** (once it is listed), then enable it.

Manually: download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/rdhallman/obsidian-live-files-plugin/releases) into `<vault>/.obsidian/plugins/live-files/`, reload Obsidian, and enable **Live Files** under Community plugins.

## Development

```bash
npm install
npm run dev        # rebuild main.js on change
npm run build      # type-check and build
npm test           # unit tests (the activity tracker and globs; node's test runner)
npm run test:e2e   # end-to-end in a real Obsidian (Linux, see below)
```

`npm run test:e2e` builds the plugin, creates a throwaway vault and Obsidian settings folder, starts a private virtual display (Xvfb) and a separate Obsidian with remote debugging, checks every feature through the real UI (following in both views, bold/expiry, own edits not highlighted, menus, clean unload), then removes everything. It never touches your own Obsidian or vaults. It needs `Xvfb` and Obsidian's Electron and `app.asar`; the defaults fit Arch Linux's `obsidian` package, otherwise set `OBSIDIAN_ELECTRON` and `OBSIDIAN_ASAR` (for an AppImage, extract it with `--appimage-extract`).

Releasing: `npm version patch|minor|major` updates `manifest.json` and `versions.json`; push the tag and the release workflow attaches `main.js`, `manifest.json` and `styles.css` to a draft GitHub release.

## License

MIT © Dean Hallman
