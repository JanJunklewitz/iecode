# IECode

Structured Text for TwinCAT in VS Code, plus a command-line tool for builds, libraries and deployment.
Open source, built to support other IEC 61131-3 platforms (CODESYS, Siemens) later.

| Folder | What it is | Runs on |
|---|---|---|
| [`extension/`](extension/) | VS Code extension: edit `.TcPOU` / `.TcDUT` / `.TcGVL` / `.TcIO` files as plain Structured Text | any OS |
| `cli/` (planned) | `iecode` CLI: build, activate, save/update/encrypt libraries via the TwinCAT Automation Interface | Windows with TwinCAT XAE (4024 / 4026) |
| [`mockup/`](mockup/index.html) | Clickable mockup of the planned features | browser |

## Requirements

- The VS Code extension works on its own; no TwinCAT installation is needed to view and edit files.
- The `iecode` CLI needs Windows and a licensed TwinCAT 3 XAE installation (3.1.4024.x or 3.1.4026.x). It uses the
  TwinCAT and Visual Studio components installed on your machine and doesn't ship them.

## Safety

`iecode activate` can change the configuration of, and restart, a real controller. Test on non-production
systems first. The software is provided "AS IS", without warranties of any kind.

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE). Contributions require a DCO sign-off, see
[CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## Trademarks

TwinCAT®, Beckhoff® and EtherCAT® are registered trademarks of Beckhoff Automation GmbH. This project is not
affiliated with, endorsed by, or supported by Beckhoff Automation GmbH. The names are used only to describe
compatibility.
