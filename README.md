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

**Settings → Updates → Check for updates** (or the tray menu's *Check for Updates…*) looks for a newer release. Veliance also checks once, quietly, on launch.

- **Signed, notarized builds** (the release pipeline below) update **in place**: *Download & install* downloads in the background, then *Restart to update* swaps in the new version — no dragging. This runs through `electron-updater` / Squirrel.Mac.
- **Dev or ad-hoc builds** can't auto-install (no Developer ID signature), so the button opens the DMG to drag over Applications, same as a fresh install.

### Releasing (signed + notarized)

Releases are built, Developer ID-signed, Apple-notarized, and published by [`.github/workflows/release.yml`](.github/workflows/release.yml) on a version tag:

```bash
npm version 2.2.0      # bumps package.json and creates the v2.2.0 tag
git push --follow-tags # the Release workflow builds, signs, notarizes + publishes
```

It produces a DMG + ZIP per arch plus `latest-mac.yml` (the feed the in-app updater reads) and attaches them to the GitHub Release.

Add these repo secrets first (**Settings → Secrets and variables → Actions**):

| Secret | What it is |
|---|---|
| `MAC_CERT_P12_BASE64` | base64 of your *Developer ID Application* certificate exported as `.p12` (`base64 -i cert.p12 \| pbcopy`) |
| `MAC_CERT_PASSWORD` | the password you set when exporting that `.p12` |
| `APPLE_API_KEY_P8` | contents of your App Store Connect API key (`.p8`) — Keys → generate one with *Developer* access |
| `APPLE_API_KEY_ID` | that key's Key ID |
| `APPLE_API_ISSUER` | the API key's Issuer ID (shown above the keys list) |
| `APPLE_TEAM_ID` | your 10-char Apple Developer Team ID |

(Prefer an Apple ID + app-specific password instead of the API key? Set `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` and tweak the `env` block in the workflow — `electron-builder` accepts either.)

Once a signed `v2.2.0+` release is out, everyone on that version and later updates one-click from inside the app. Users still on an older, ad-hoc 2.x build take the manual DMG path once to cross over.

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
