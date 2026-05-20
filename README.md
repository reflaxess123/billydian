# Billydian

Vault-based notes + AI mind maps on top of OpenRouter. Pick a folder —
`.md` files become rendered notes (with KaTeX math), `.mindmap` files
become interactive trees. Edit Markdown inline, expand mind-map nodes
with the LLM of your choice, regenerate a note's title from its body.

Built with Tauri 2 + React 19 + d3-hierarchy + react-markdown.

## Install

Grab the latest `Billydian_<version>_x64-setup.exe` from the
[Releases](https://github.com/reflaxess123/billydian/releases) page and
run it. Per-user install (no admin needed). Windows 10/11 x64.

You'll need an **OpenRouter API key** (paste it in Settings after launch
— get one at [openrouter.ai](https://openrouter.ai)).

## Develop

```bash
npm install
npm run tauri dev
```

## Build the installer locally

```powershell
.\scripts\build-installer.ps1
```

The .exe lands in `src-tauri/target/release/bundle/nsis/`.

## Release

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions builds the NSIS installer and attaches it to a new
Release automatically.
