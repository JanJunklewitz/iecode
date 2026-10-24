# Security policy

## Reporting a vulnerability

Please **don't** report security issues in public issues, discussions or pull requests.

Use GitHub's private vulnerability reporting instead: **Security → Report a vulnerability** on this
repository. Include the affected component (VS Code extension, `iecode` CLI, installer, GitHub Action),
the version, and steps to reproduce.

You'll get an acknowledgement within 7 days. Fixes are released as soon as practical, and reporters are
credited in the release notes unless they prefer otherwise.

## Supported versions

Only the latest release receives security fixes.

## Scope

In scope, for example:

- Code execution or file writes outside the workspace triggered by opening a crafted TwinCAT file or workspace
- `iecode` CLI actions on a target system that the user didn't request (activation, restart, library install)
- Leaking credentials for library feeds or package sources
- Tampering with downloads in the install script, release artifacts or the tcpkg package

Out of scope: vulnerabilities in TwinCAT, TcXaeShell, Visual Studio or ADS themselves. Report those to
[Beckhoff](https://www.beckhoff.com/en-en/support/) or Microsoft.

## Safety note

`iecode activate` can change the configuration of, and restart, a real controller. This software is
provided "AS IS", without warranties of any kind (see LICENSE). Test on non-production systems first.
