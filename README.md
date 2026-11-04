# Claude Float

A floating claude.ai panel for macOS. Press **Option+Space** to show or hide it — or to launch it if it isn't running.

- It's a non-activating panel, like Spotlight: it floats above everything, shows on every Space and full-screen app, and follows you across AeroSpace workspaces.
- Drag it by the strip at the top. Its position is remembered.
- **Esc** or **Cmd+W** hides it. **Cmd+Q** (or the ✦ menu-bar icon → Quit) quits.
- No Dock icon. The ✦ menu-bar icon has Show/Hide, Reload, and Launch at Login.

## Build & install

```bash
npm install
npm run package   # builds dist/ and copies "Claude Float.app" to /Applications
```

`npm start` runs it from source. `npm run trace` also writes timing data to
`~/Library/Logs/claude-pop-out/trace.log`: show → first frame, window moves, and slow input events.

## Option+Space with AeroSpace

To let Option+Space also launch the app after you quit, bind it in `~/.aerospace.toml`:

```toml
alt-space = 'exec-and-forget pkill -USR2 -x "Claude Float" || open -g -a "Claude Float"'
```

If the app is running, the key sends it `SIGUSR2` to toggle. Otherwise the key launches it in the background, so AeroSpace doesn't take over the window. When this binding is present, the app doesn't register Option+Space itself.
