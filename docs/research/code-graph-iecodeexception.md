# Why `IECodeException` bridges so many communities

Finding from the code graph described in [code-graph-overview.md](code-graph-overview.md)
(snapshot 2026-11-27, `main` at `2bc4bff`).

## Question

`IECodeException` is the most connected node in the graph (103 edges) and links about 18
communities. Is that a real coupling or an extraction artifact?

## Answer

It is real, and it is by design. `IECodeException` (`cli/src/IECode.Core/Errors.cs:26`) is the one
error type the whole CLI throws. Every feature builds its own errors from it, so it connects
features that otherwise do not depend on each other. The graph's high betweenness score
(0.012) reflects a cross-cutting concern, not tight coupling.

## What connects to it

Almost all edges are incoming `calls` edges, meaning "constructs or throws".

- **Core:** `PlcValueText.Parse`, `AdsInterface.FromTmc`, `PlcProjectFile.Load`, `Workspace.Load`,
  `SolutionFile.Load`, `LibraryRepository.Scan`, `AmsNetId.Parse`, `TwinCatVersion.Parse`, `Git`.
- **Automation:** `XaeShell.Start/Build/Activate/SetAndConfirm`, `Target.Connect/FindSymbol`,
  `RepTool.Find`, `AdsWatchBackend.ReadMembers/Find`, `OnlineSymbolList.List`.
- **CLI commands:** `LibraryCommands.*`, `TargetCommands.*`, `ProjectCommands.*`,
  `WorkspaceCommands.Build/Release`, `Runner.Run/Credentials`.
- **Tests:** `PlcValueTextTests`, `ParsingTests`, `ProjectTests`, `WatchHostTests`,
  `OnlineSymbolListTests`.

Files with the most edges: `XaeShell.cs` (6), `LibraryCommands.cs` (6), `PlcValueTextTests.cs` (6),
`XaeShell.Plc.cs` (5), `WatchHost.cs` (5), `Git.cs` (4).

The callers sit in many different communities: Library Identity, Beckhoff Link, COM Call Retry,
Rep Tool, Watch Host Backend, ADS Client Symbols, CLI Tools & Library Cmds, Workspace Commands,
XAE Shell Options and more. The `Exception` base-class node that shows up in traversals
has no source file; it is an external reference and says nothing about the code.

## Verification of the INFERRED edges

78 of the 103 edges are INFERRED (confidence 0.85), produced by the extractor rather than the AST.
They were checked against the source:

1. For each edge, read the cited file at the cited line plus or minus two lines.
2. Check that `IECodeException` occurs there: **78 of 78 confirmed**.
3. Check that the occurrence is `new IECodeException` or `throw ... IECodeException`, not a
   `catch` or `is` test: **78 of 78 are construct or throw**, which matches the edge type `calls`.

Limits: this proves the throw site exists at the cited place. It does not prove the edge is
attached to the right enclosing method, though the cited line lies inside the caller.

## Takeaway

No action needed. If the exception type is ever split (for example one type per layer),
this graph is a ready-made impact list: every caller above would change.

## Reproduce

```
graphify explain "IECodeException"
graphify query "Why does IECodeException connect so many communities?" --budget 2000
```
