# Veliance

An invisible AI overlay for your desktop. A small command bar floats above every app, is excluded from screen sharing / recording / screenshots at the OS level, and answers from your own API key.

- **Ask** anything from a floating input (⌘↵)
- **Screenshot & answer** — captures your screen and sends it to a vision model (⌘⇧S)
- **Listen** — live transcription of system audio (calls, videos) or your mic, then "Answer" the latest question (⌘⇧L, then ⌘↵)
- **Invisible** — hidden from Zoom, Meet, Teams, QuickTime, OBS, screenshots; not in the Dock, Mission Control or ⌘-Tab
- Bring your own key: **Anthropic** or **OpenAI** (OpenAI is also used for transcription)

## Download

Grab the latest DMG from **[Releases](https://github.com/aomine97/veliance/releases/latest)**:

- `Veliance-<version>-arm64.dmg` — Apple Silicon (M1/M2/M3/M4…)
- `Veliance-<version>-x64.dmg` — Intel Macs

Open the DMG and drag **Veliance** onto **Applications**.

The app isn't signed with an Apple Developer ID, so the first launch is blocked with *"Veliance can't be opened"* / *"is damaged"*. Either:

- **System Settings → Privacy & Security**, scroll down, click **Open Anyway** next to the Veliance message, or
- run this once in Terminal, then open it normally:

  ```bash
  xattr -cr /Applications/Veliance.app
  ```

Veliance lives in the menu bar (no Dock icon). Press **⌘ \\** to show or hide the overlay.

## Setup (from source)

```bash
git clone https://github.com/aomine97/veliance.git
cd veliance
npm install
npm start
```

Requires Node 18+ (20+ recommended). First launch opens Settings — paste an API key, hit **Save**, then **Test**.

### macOS permissions (one time)

1. **Screen Recording** — needed for ⌘⇧S screenshots and for system-audio Listen. System Settings → Privacy & Security → Screen Recording → enable *Electron* (dev) or *Veliance* (packaged). **Relaunch after granting.**
2. **Microphone** — only if you pick the mic as the Listen source.

The tray menu (top-right menu bar icon) has shortcuts to both settings panes.

## Hotkeys

| Keys | Action |
|---|---|
| ⌘ \ | Show / hide the overlay |
| ⌘ ↵ | Ask — sends the input box; if Listen is on and the box is empty, answers the live transcript |
| ⌘ ⇧ S | Screenshot the screen and answer what's on it (⌥-click the button to attach without sending) |
| ⌘ ⇧ L | Start / stop Listen |
| ⌘ ⇧ C | Clear the conversation |
| ⌘ ⇧ ↑ ↓ ← → | Nudge the overlay |
| ⌘ = / ⌘ - | Grow / shrink the overlay |
| ⌘ ⇧ Q | Quit |

All of these are editable: Settings → Hotkeys → click a combo → press the new keys. Esc cancels, ⌫ disables that hotkey, **Reset all** restores defaults. Combos already owned by another app or macOS show in amber and won't fire; pick another.

Drag the grip on the left of the bar to move it. Position, size, opacity, hotkeys and settings persist between launches.

## Updating

**Settings → Updates → Check for updates** (or the tray menu's *Check for Updates…*) asks GitHub for the latest release and, if there's a newer version, offers to download the right DMG for your Mac (arm64 / x64). Drag it over the old **Veliance** in Applications as usual. Veliance also checks once, quietly, on launch and shows a note if an update is waiting.

Releases are built automatically by [`.github/workflows/release.yml`](.github/workflows/release.yml): bump the version and push a tag and the workflow builds both DMGs and publishes them.

```bash
npm version 2.1.0      # bumps package.json and creates the v2.1.0 tag
git push --follow-tags # the Release workflow builds + publishes the DMGs
```

## How the hiding works

`BrowserWindow.setContentProtection(true)` sets `NSWindowSharingNone` on macOS (and `WDA_EXCLUDEFROMCAPTURE` on Windows 10 2004+). Every capture path that goes through the OS compositor — screen share in any meeting app, QuickTime / OBS recording, ⌘⇧3/4 screenshots, `desktopCapturer` — omits the window. Additionally:

- `alwaysOnTop` at `screen-saver` level, `type: 'panel'` and `visibleOnFullScreen` keep it above full-screen apps and on every Space
- `app.dock.hide()` + `LSUIElement` keep it out of the Dock and ⌘-Tab
- `setHiddenInMissionControl(true)` keeps it out of Mission Control
- `skipTaskbar` on Windows
- Transparent areas are click-through (`setIgnoreMouseEvents` with forwarding), so it never blocks what's underneath

What it **cannot** hide from: a phone camera pointed at the screen, an HDMI capture device, or a remote-desktop session that streams the raw framebuffer.

## Settings

- **Model picker** — the dropdown on the command bar switches between Claude (Anthropic) and ChatGPT (OpenAI) models in one click. With a key saved, it lists the models live from each provider.
- **Answer with** — Anthropic (`claude-opus-5-5` default) or OpenAI (`gpt-4o` default). Model IDs can also be typed in Settings.
- **Listen source** — system audio (loopback via ScreenCaptureKit, needs Screen Recording) or microphone. Falls back to mic automatically if system audio is unavailable.
- **Transcribe model** — `gpt-4o-mini-transcribe` (default) or `whisper-1`.
- **System prompt** — how it answers. Default is tuned for short, direct, lead-with-the-answer replies.
- Keys are encrypted with the OS keychain (`safeStorage`) and never leave the main process; the UI only knows whether a key exists.

## Packaging as an app

```bash
npm run pack          # build + install /Applications/Veliance.app (this Mac's arch)
npm run pack:intel    # same, Intel build
npm run dmg           # → dist/Veliance-<version>-arm64.dmg and -x64.dmg for distribution
```

`scripts/pack.js` reuses any Electron zip already on the machine (so it doesn't depend on the postinstall download), builds the bundle, ad-hoc signs it (required on Apple Silicon) and strips the quarantine flag. Ad-hoc signatures change on every build, so after rebuilding you may need to remove and re-add Veliance under Screen Recording. First screenshot will prompt for Screen Recording permission for *Veliance* (separate from the Electron dev permission); grant it and relaunch.

For a DMG with a real Developer ID signature, add your identity to the `build.mac` block in `package.json` and run `npm run dist`.

## Layout

```
main.js        window, invisibility, hotkeys, tray, screenshot, IPC
ai.js          Anthropic / OpenAI streaming, vision, transcription
store.js       config + encrypted keys (userData/config.json)
preload.js     contextBridge API exposed as window.veliance
renderer/      index.html · styles.css · app.js  (the overlay UI)
scripts/       pack.js (build .app / .dmg) · sign.js (ad-hoc sign)
assets/        app icon · tray icon
build/         macOS Info.plist additions · entitlements
```
