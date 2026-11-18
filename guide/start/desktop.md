# Desktop app

The desktop app is the builder for one person. It runs entirely on your computer: projects, provider accounts and the database stay there.

## Install

1. Open the [latest release](https://github.com/bennet0904/lotse/releases/latest) and download the file for your system:

   | System                              | File                                                                             |
   | ----------------------------------- | -------------------------------------------------------------------------------- |
   | macOS (Apple silicon: M1 and later) | `Lotse-<version>-arm64.dmg`                                                      |
   | Windows                             | `Lotse.Setup.<version>.exe`                                                      |
   | Linux                               | `Lotse-<version>.AppImage`, or `lotse_<version>_amd64.deb` for Debian and Ubuntu |

2. Install it as usual for your system.

::: warning Pre-release builds are not signed yet
Your system warns about an app from an unknown developer the first time.

- **macOS:** right-click (or Control-click) the app in _Applications_, choose **Open**, then confirm with **Open**.
- **Windows:** when SmartScreen says _Windows protected your PC_, choose **More info**, then **Run anyway**.
- **Linux (AppImage):** make the file executable (`chmod +x Lotse-*.AppImage`) and start it.
  :::

## A container runtime

The builder runs every project in a container, so it needs a container runtime. When you start the app without one, the start page explains what to do. Any of these works:

- **Podman Desktop** — free for every use, also in companies. Install it from [podman-desktop.io](https://podman-desktop.io/downloads), start it once, and enable _Settings → Docker Compatibility_. On Linux, `systemctl --user enable --now podman.socket` is enough.
- **Docker Desktop** — needs a paid license in larger companies.
- **Docker Engine** on Linux, or **OrbStack** on macOS.

You do not need to restart Lotse after starting the runtime: it is found on the next action.

## A language model

The builder needs a language model to plan and write apps. Open **Settings → Language models** and either

- enter an **Anthropic API key** (the default model is Anthropic's), or an **OpenAI API key** and set the default model to an OpenAI model, or
- use a model on your own computer: install [Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai), download a coding model, and set the default model, e.g. `ollama:qwen3-coder`. Local models cost nothing.

See [Language models and cost](../build/models) for details.

## Where your data is

| What                                         | Where                                                                                                                      |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Projects, database, sandbox caches           | `~/Library/Application Support/Lotse/data` (macOS), `%APPDATA%\Lotse\data` (Windows), `~/.config/Lotse/data` (Linux)       |
| The key that encrypts your provider accounts | Sealed by your system's keychain (Keychain on macOS, the Windows credential protection, GNOME Keyring or KWallet on Linux) |

On Linux without a keyring, the key is kept in a file only your user can read, and Lotse tells you once. Install and unlock GNOME Keyring or KWallet to protect it better.

To move to another computer, copy the data folder. Provider accounts cannot be read on the new computer, because the key stays in the old computer's keychain; connect them again there.

## Signing in to providers

When you connect a provider that offers sign-in with OAuth ("Continue at …"), the provider's page opens in your normal browser, where you are probably signed in already. Approve access there, then return to Lotse: the account appears by itself.

## Privacy

The app starts the builder on your computer only (`127.0.0.1`), and only the app's own window can use it — other programs and web pages cannot, even though there is no sign-in. Nothing is sent anywhere except to the language model and the providers you choose.
