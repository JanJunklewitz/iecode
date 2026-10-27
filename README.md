# IECode

Structured Text for TwinCAT in VS Code, plus a command-line tool for builds, libraries and deployment.
Open source, built to support other IEC 61131-3 platforms (CODESYS, Siemens) later.

| Folder | What it is | Runs on |
|---|---|---|
| [`extension/`](extension/) | VS Code extension: edit `.TcPOU` / `.TcDUT` / `.TcGVL` / `.TcIO` files as plain Structured Text | any OS |
| [`cli/`](cli/) | `iecode` CLI: build, check, activate, libraries, protection, ADS ([commands](cli/README.md)) | Windows with TwinCAT XAE (4024 / 4026); file-based commands on any OS |
| [`packaging/`](packaging/) | `install.ps1` (per-user install from GitHub Releases), NuGet / tcpkg package spec | Windows |
| [`setup-iecode/`](setup-iecode/action.yml) | GitHub Action: `uses: JanJunklewitz/iecode/setup-iecode@v0` | Windows runners |
| [`mockup/`](mockup/index.html) | Clickable mockup of the features | browser |

## Install

- **VS Code extension:** VS Code Marketplace / Open VSX ("IECode"), or the `.vsix` from [GitHub Releases](https://github.com/JanJunklewitz/iecode/releases).
- **CLI (Windows):** `irm https://github.com/JanJunklewitz/iecode/releases/latest/download/install.ps1 | iex`,
  or the `IECode.Cli` NuGet package from the GitHub Packages feed (also usable as a TwinCAT Package Manager source),
  or **IECode: Set up this PC** in VS Code (installs the CLI and checks TwinCAT).

## Requirements

- The VS Code extension works on its own; no TwinCAT installation is needed to view and edit files.
- The `iecode` CLI needs Windows and a licensed TwinCAT 3 XAE installation (3.1.4024.x or 3.1.4026.x). It uses the
  TwinCAT and Visual Studio components installed on your machine and doesn't ship them.

## Safety

`iecode activate` can change the configuration of, and restart, a real controller. Test on non-production
systems first. The software is provided "AS IS", without warranties of any kind.

## License

[MIT License](LICENSE). See [NOTICE](NOTICE). Contributions require a DCO sign-off, see
[CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## Trademarks

TwinCAT®, Beckhoff® and EtherCAT® are registered trademarks of Beckhoff Automation GmbH. This project is not
affiliated with, endorsed by, or supported by Beckhoff Automation GmbH. The names are used only to describe
compatibility.
