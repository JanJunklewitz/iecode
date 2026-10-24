# iecode CLI

TwinCAT 3 engineering from the command line: build, check, activate, save and update libraries,
protect projects, talk to targets over ADS. Made for developer machines and CI.

- **Windows + TwinCAT XAE (4024 / 4026)** for everything that drives the XAE shell or ADS.
- **Any OS** for the file-based commands: `info`, `lib list | info | update | outdated | installed | restore --dry-run`,
  `ws list | graph | build --dry-run | release --no-save`, `clean --artifacts`.
- Every command supports `--json` (one JSON document on stdout) and returns [stable exit codes](#exit-codes).

## Commands

| Command | What it does | Needs |
|---|---|---|
| `info [sln] [--installed]` | TwinCAT and PLC projects, saved TwinCAT version, library metadata; `--installed` lists installed TwinCAT versions | files (`--installed`: XAE) |
| `build [sln] [-p <platform>]… [--clean] [-c <config>]` | Build one or more target platforms; compiler messages with file and line | XAE |
| `check [sln]` | "Check all objects" on every PLC project | XAE |
| `clean [sln]` | Clean the solution in XAE | XAE |
| `clean [folder] --artifacts [--boot] [--dry-run]` | Delete generated `_CompileInfo` (and `_Boot`) folders | files |
| `activate [sln] [-t <netid>]… [--no-restart] [--no-build] [--project <name>]` | Build, activate the configuration on one or more targets (default: local), restart in run mode. Confirms the "potential symbol type change" dialog | XAE |
| `encrypt [sln] --protect "<tree path>,encrypted=true,signed=true,level=<name>"…` | Object protection with TwinCAT 3 Security Management (encryption, signing, protection level) | XAE |
| `encrypt [sln] --compiled-library [--plc <name>] [--out <dir>]` | Ship a library without source | XAE |
| `user status` | Active TwinCAT user (after `--userdb` / `--user` / `--credential`) | XAE |
| `lib save [sln] [--compiled] [--install] [--plc <name>] [-o <dir>]` | Save a PLC project as `<Title>_<Version>.library` / `.compiled-library` | XAE |
| `lib list [paths…] [--csv <file>]` | Library references and the version that applies (pinned or `*`) | files |
| `lib info [paths…]` | Title, company and version of library projects | files |
| `lib update [paths…] --lib <name> (--to <ver>\|--to latest\|--from-project <plcproj>) [--vendor] [--dry-run]` | Set a library version in every `.plcproj` below the paths. Edits text in place: formatting, BOM and CRLF stay | files |
| `lib outdated [paths…] [--repository <dir>]` | Pinned references with a newer version in the library repository | files |
| `lib installed [--lib <name>] [--repository <dir>]` | Libraries in the local library repository | files |
| `lib restore [paths…] -s <folder>… [--dry-run]` | Install the library versions pinned in the `.plcproj` files that are missing locally (CI, fresh PCs) | TwinCAT (`--dry-run`: files) |
| `lib install <file\|folder> [--overwrite] [--profile]` | Install libraries (RepTool) | TwinCAT |
| `lib uninstall <name>… --vendor <vendor> [--version all]` | Remove libraries (RepTool) | TwinCAT |
| `ws list [folder]` | Libraries, applications and standalone PLC projects in a workspace folder | files |
| `ws graph [folder] [--format text\|mermaid]` | Library dependencies (workspace link or pinned) and build order | files |
| `ws build [folder] [--affected [--since <ref>\|--changed <file\|id>…]] [--dry-run]` | Build in dependency order with one XAE shell; workspace libraries are saved + installed before their users | XAE (`--dry-run`: files) |
| `ws release <library> [--bump major\|minor\|patch\|<ver>] [--update-dependents] [--include-pinned] [--no-save]` | Bump the library version, save + install it, set the new version in the projects that use it | XAE (`--no-save`: files) |
| `target state\|run\|config [-t <netid>]` | TwinCAT runtime state, restart in run mode, switch to config mode | ADS |
| `ads read <symbol> [-t] [--port 851]` / `ads write <symbol> <value>` | Read / write PLC variables | ADS |
| `doctor` | Check TwinCAT, shells, RepTool and library repository on this machine | – |

### Global options

| Option | |
|---|---|
| `--tc 4024 \| 4026 \| 4024.66 \| 3.1.4024.66 \| auto` | TwinCAT version. `auto` uses the version the project was saved with if it's installed, otherwise the shell's default. Selected through the TwinCAT Remote Manager |
| `--prog-id` | DTE ProgID, e.g. `TcXaeShell.DTE.17.0`; default is picked from `--tc` |
| `--userdb <file.tcudb>` | Select a user database before opening the project |
| `--user <name>` | Log in to TwinCAT user management; password from `IECODE_PASSWORD` or a prompt |
| `--credential <target>` | Log in with a generic credential from the Windows Credential Manager (asked and saved on first use) |
| `--visible`, `--show-ui` | Show the XAE window / allow its message boxes (both off by default) |
| `--timeout <s>` | Abort build or activation after N seconds (default 1800) |
| `--json`, `-v/--verbose`, `--no-color`, `-y/--yes`, `--pause` | Output and interaction |

Commands that change a remote target, delete files or protect a project ask first. In scripts and CI pass `--yes`;
without it, a non-interactive run stops with exit code 130 instead of assuming yes.

## Examples

```bash
iecode build MachineX.sln -p "TwinCAT RT (x64)" --tc 4024.66
iecode activate MachineX.sln -t 5.80.201.232.1.1 --yes
iecode lib save Tc3_MotorLib.sln --compiled --install -o dist
iecode lib update ../apps --lib Tc3_MotorLib --to latest --dry-run
iecode encrypt MachineX.sln --userdb Security/MachineX.tcudb --credential machinex-oem \
  --protect "TIPC^PLC1^PLC1 Project^POUs,encrypted=true,signed=true,level=Service" --yes
iecode ads write MAIN.bStart true -t local
```

## JSON output

```json
{ "command": "build", "ok": false, "exitCode": 10, "durationMs": 18412, "twinCat": "3.1.4024.66",
  "data": { "builds": [ { "platform": "TwinCAT RT (x64)", "ok": false, "errors": 1, "warnings": 0 } ] },
  "diagnostics": [ { "severity": "error", "code": "C0077", "message": "Unknown type: 'fSped'",
                     "file": "C:\\…\\FB_Motor.TcPOU", "project": "PLC1", "line": 2, "column": 13 } ],
  "messages": [ "…" ] }
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | Failed |
| 2 | Invalid arguments |
| 3 | File, project or symbol not found |
| 10 | Build / check failed |
| 11 | Activation failed |
| 12 | Library operation failed |
| 13 | Protection failed |
| 14 | User management (user DB, login) failed |
| 15 | Requested TwinCAT version not installed |
| 16 | Target / ADS error |
| 17 | Timeout |
| 20 | Command needs Windows with TwinCAT |
| 99 | Unexpected error |
| 130 | Cancelled / confirmation needed (`--yes`) |

## How it works

- `IECode.Core` (any OS): solution, `.tsproj`/`.tspproj` and `.plcproj` reading, library reference edits,
  version and NetId parsing, library repository scan, output. Fully unit-tested.
- `IECode.Automation` (Windows at runtime): starts the XAE shell through its DTE ProgID and drives EnvDTE and
  the TwinCAT Automation Interface with **COM late binding**. No Beckhoff or Microsoft interop assemblies are
  referenced or shipped; the components installed with TwinCAT are used. A COM message filter retries calls
  while the shell is busy, the shell runs hidden with silent mode, and it's always closed at the end.
  RepTool is used for library install/uninstall, `Beckhoff.TwinCAT.Ads` (MIT) for ADS.
- `IECode.Cli`: `iecode` command line (System.CommandLine).

## Develop

```bash
cd cli
dotnet build IECode.slnx
dotnet test --solution IECode.slnx
dotnet run --project src/IECode.Cli -- lib list ../extension
```

The XAE-driven commands can only be tested on Windows with TwinCAT XAE. They have not been run against a real
TwinCAT installation yet. Please report what works and what doesn't, with the TwinCAT version.
