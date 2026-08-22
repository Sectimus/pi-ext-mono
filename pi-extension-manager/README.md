# pi-extension-manager

A [pi](https://pi.dev) extension that adds a `/extensions` menu for managing the extensions pi has loaded.

## Install

```bash
pi install /path/to/pi-extension-manager   # local checkout
pi install git:github.com/<you>/pi-extension-manager
```

## Usage

Run `/extensions` in pi.

**List view**

- type to fuzzy-search by name, package source or scope
- `↑`/`↓` move, `enter` opens the action menu for the highlighted extension
- `space` toggles enable/disable without leaving the list (when the search box is empty)
- `esc` closes the menu

Each row shows the enabled checkbox, the extension name, its kind (`npm`, `git`,
`local package`, `settings path`, `local file`), scope (`user`/`project`) and, for
downloaded extensions, the version. Rows with an available update are highlighted
as `local → remote`.

**Action menu**

| Action | Availability | Behaviour |
|---|---|---|
| Enable / Disable | all | Writes a `+path` / `-path` pattern into the owning scope's settings, exactly like `pi config`. Disabling is greyed out for the extension manager itself, since that would remove the only way back into this menu. |
| Check version | npm/git only | npm: installed `package.json` version vs `npm view`. git: local HEAD vs `git ls-remote` (short SHAs). |
| Update | npm/git only | Runs pi's own package updater for that source. Disabled for npm sources pinned to an exact version (pi never moves those). |
| Delete | all | Always asks for confirmation (`y`/`n`). Packages are uninstalled and dropped from settings; `settings.extensions` entries are removed from settings; auto-discovered files/directories are deleted from disk. |

Version check and update are hidden behind a disabled state when pi runs offline
(`PI_OFFLINE=1`).

After any change the menu offers to `/reload` so the new configuration takes
effect in the running session; declining leaves the changes on disk for the next
`/reload` or restart.

## Notes

- Deletion of a package uninstalls it for the scope it is configured in (user or
  project) and removes the entry from that settings file.
- The menu never installs anything implicitly: missing package sources are
  skipped while resolving rather than fetched.
- Project-scoped resources are only touched when the project is trusted.
