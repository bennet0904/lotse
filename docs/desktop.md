# Desktop app

The desktop app is the builder for one person on Windows, macOS or Linux. Projects, provider accounts and the database stay on your computer.

## Install

Download the installer from the releases page: `.dmg` for macOS, `.exe` for Windows, AppImage or `.deb` for Linux. Releases are signed; on macOS they are notarized.

## Container runtime

Previews run your app in a container, so the desktop app needs a container runtime. On first launch it looks for one and, if none is running, explains what to do:

- **Podman** (free for every use, including companies): install [Podman Desktop](https://podman-desktop.io/downloads), start it, and enable the Docker-compatible socket under _Settings → Docker Compatibility_. On Linux, `systemctl --user enable --now podman.socket` is enough.
- **Docker Desktop** (needs a paid license in larger companies) or **Docker Engine** on Linux.
- **OrbStack** on macOS.

A runtime started after the app is found without restarting it. Podman is supported as an equal alternative to Docker, including rootless Podman.

## Where your data is

| What                                        | Where                                                                                                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projects, database (SQLite), sandbox caches | The app's user data folder: `~/Library/Application Support/Lotse/data` (macOS), `%APPDATA%\Lotse\data` (Windows), `~/.config/Lotse/data` (Linux)         |
| Master key of the credential store          | Sealed by the operating system's keychain (Keychain on macOS, DPAPI on Windows, Secret Service or KWallet on Linux) in `master.key.enc` next to the data |

On Linux desktops without a keyring the key is kept in a file only your user can read, and the app tells you once. Install and unlock GNOME Keyring or KWallet to protect it better.

## Security

The app starts the builder on `127.0.0.1` and opens it in its own window. Only that window can use it: other programs and web pages on your computer get no access, even though there is no sign-in. Sign-ins to providers open in your system browser; when you are done there, return to the app and the account appears.

## Building it yourself

```sh
pnpm install && pnpm build
pnpm --filter @lotse/desktop start    # run from the workspace
pnpm --filter @lotse/desktop dist     # installers for the current platform, in packages/desktop/release
```

`dist` bundles the main process with all packages into one file without native modules (the app uses the SQLite built into Electron's Node.js) and writes the licenses of the bundled packages to `THIRD_PARTY_LICENSES.txt`.
