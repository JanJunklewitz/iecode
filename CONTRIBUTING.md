# Contributing

Thanks for helping! Issues and pull requests are welcome.

## Developer Certificate of Origin (DCO)

This project uses the [Developer Certificate of Origin 1.1](https://developercertificate.org/) instead of a CLA.
By signing off a commit you certify that you wrote the change, or otherwise have the right to submit it
under the project's license (MIT).

Sign off every commit with `-s`:

```bash
git commit -s -m "Add method wizard"
```

This adds a line with your real name and email:

```
Signed-off-by: Jane Doe <jane.doe@example.com>
```

Forgot it? Amend the last commit with `git commit --amend -s --no-edit`, or sign off a whole branch with
`git rebase --signoff main`. Pull requests with unsigned commits can't be merged.

## What not to contribute

- Code you may not license under MIT, including code copied from GPL projects or from your
  employer without permission.
- Beckhoff or Microsoft binaries, interop assemblies or type libraries (for example `TCatSysManagerLib`,
  `EnvDTE`, `TwinCAT.Ads` DLLs). `iecode` uses the copies installed on the user's machine.
- Beckhoff library sources (`Tc2_*`, `Tc3_*`, `.library` files) or text copied from Beckhoff documentation.
  Link to the documentation instead.
- Real PLC projects from customers or employers, real AMS NetIds, hostnames, credentials or tokens.
  Test fixtures must be synthetic.

## Development

- Extension: `cd extension && npm install && npm test`
- End-to-end test in VS Code: `./extension/scripts/e2e.sh`
- Keep pull requests focused, add tests for parser/round-trip changes, and describe how you tested
  against TwinCAT (version, e.g. 3.1.4024.66) if your change touches the CLI.

## Reporting security issues

Don't open a public issue. See [SECURITY.md](SECURITY.md).

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). By participating you agree to uphold it.
