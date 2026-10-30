# What changes in PLC `.xti` files? (survey, 2026-10-30)

Research for the TODO item *Semantic diff for system config files (e.g. `_Config\PLC\Plc.xti`)*.
Goal: find out which parts of a PLC instance `.xti` really change in day-to-day commits, which of them matter to a reviewer, and which are noise, so the diff view's categories, filters and defaults are based on data instead of guesses.

## Data set and method

- 17 PLC `.xti` files (`_Config/PLC/Plc.xti`, `_Config/PLC/Plc Instance.xti`) from production TwinCAT 3.1 (4024.x) projects, each with its own git history.
- Up to 40 most recent non-merge commits per file: **390 commits analysed**. 25 more commits with over 150k changed lines were skipped: full rewrites, e.g. after a TwinCAT version pin, a file split or a cycle time change. 148 of the analysed commits still change more than 20k lines, so a raw text diff is unusable for review.
- Script: [xtistats.js](xtistats.js) (`node xtistats.js <maxCommitsPerFile> <absolute .xti paths...>`). For every commit it
  1. takes `git diff -U0 <c>^ <c>` of the file,
  2. maps every line of the old and new file to its XML element path (`Project/Instance/TmcDesc/DataAreas/DataArea/Symbol/Name`) and to the `<Name>` of its parent element (e.g. the `Value` of the parameter named `Application Timestamp`),
  3. pairs removed/added lines inside a hunk; a pair on the same path is a *change* and reports which attributes / text differ, everything else is *added* / *removed*,
  4. sorts each changed line into a category (see below) and counts commits and lines per category.
- Data (anonymised, no project names or commit messages):
  - [data/categories.txt](data/categories.txt): totals per category,
  - [data/change-keys.tsv](data/change-keys.tsv): every change key (XML path + changed attribute) with commit and line counts, for re-categorising without re-running the script,
  - [data/files.tsv](data/files.tsv): the analysed files (variant, size, commit count).
- Limitations: line-based, not a real XML diff. When a block is inserted, the following lines of the hunk pair up wrongly and count as added/removed, which inflates the line counts (especially for embedded data types). The **commit percentages** are reliable. The line counts only show orders of magnitude.

## File structure

Two variants exist:

- **Monolithic**: `Plc.xti` holds everything (75k-320k lines).
- **Split** (TwinCAT "independent files"): a tiny `Plc.xti` (6 lines, `<Project ...><Instance File="Plc Instance.xti"/></Project>`) plus a large `Plc Instance.xti`. The small file only changes in `Project` attributes and `TcVersion`.

Main sections:

```
TcSmItem @TcVersion
├─ DataTypes/DataType ...            copy of all data types from the TMC (largest part of the file)
├─ Project @AmsPort @...ArchiveSettings @CopyTmcToTarget @SymbolicMapping
│  └─ Instance @Id @TmcPath @TmcHash @AutoReloadTmc @LastKnownRefactorCnt
│     ├─ Name, CLSID
│     ├─ TmcDesc
│     │  ├─ Licenses/License/LicenseId
│     │  ├─ Contexts/Context (Id, Name, ManualConfig/OTCID, Priority, CycleTime, DependOn)
│     │  ├─ Parameters/Parameter (Name, BaseType, PTCID)
│     │  ├─ ParameterValues/Value (Name + Value/String/Data)
│     │  ├─ Properties/Property (ApplicationName, ChangeDate, GeneratedCodeSize, GlobalDataSize)
│     │  └─ DataAreas/DataArea (AreaNo @AreaType, Name, ContextId, ByteSize)
│     │     └─ Symbol (Name, Comment, BitSize, BaseType, BitOffs, Default, Properties, ArrayInfo)
│     ├─ Contexts / TaskPouOids           (in some files directly below Instance)
│     └─ UnrestoredVarLinks @ImportTime/OwnerA/OwnerB/Link @RestoreInfo
└─ Mappings/OwnerA/OwnerB/Link @VarA @VarB   IO links
```

## Results

Share of the 390 commits that touch a category. A commit usually touches several categories.

| Category | Commits | Changed lines | Verdict |
|---|---:|---:|---|
| Noise: build info | 84 % | 41k | noise |
| Embedded data types (`DataTypes`) | 83 % | ~4M (inflated, see limitations) | relevant, but buried under GUID noise |
| Layout (`BitOffs`, `BitSize`, `ByteSize`, `Get/SetCodeOffs`) | 82 % | 1.65M | noise in most cases |
| Noise: GUID-only changes | 82 % | 895k | noise |
| Process image symbols (`DataAreas/.../Symbol`) | 81 % | 179k | **main content** |
| Noise: whitespace | 78 % | 44k | noise |
| Metadata (`TmcHash`, `LastKnownRefactorCnt`, `TcVersion`) | 71 % | 280 | mostly noise, `TcVersion` is useful |
| IO links (`Mappings`) | 67 % | 7k | out of scope (IO links diff) |
| Instance parameters (`Parameters`, `ParameterValues`, without build info) | 44 % | 4k | relevant |
| Unrestored links (`UnrestoredVarLinks`) | 24 % | 4.7k | relevant (warning) |
| Licenses | 9 % | 1.5k | relevant |
| Noise: timestamps (`UnrestoredVarLinks@ImportTime`) | 7 % | 28 | noise |
| Other (unclassified) | 5 % | 21 | fallback |
| Tasks (`Contexts`, `TaskPouOids`) | 3 % | 192 | rare, **high impact** |
| Project / instance settings | 2 % | 51 | rare, high impact |

**Only 8 % of the commits contain nothing but noise, layout, metadata and links.** So almost every commit has a real change to show, and the volume around it is noise. That is what the filters have to remove.

### Details per category

- **Noise: build info**: values that change on every build, identified by the `<Name>` of their parent element: `Application Timestamp`, `Refactory Counter` (`ParameterValues`), `ChangeDate`, `GeneratedCodeSize`, `GlobalDataSize` (`TmcDesc/Properties`). Also the enum helper names in data type properties, `to_string_function` / `to_wstring_function` = `__TO_STRING__<n>` (the number changes per build).
- **Noise: GUID**: `GUID` attributes on `DataType/Name`, `SubItem/Type`, `BaseType`, `Method/.../Type`, `Symbol/BaseType`; `GuidA` / `IdA` in `UnrestoredVarLinks`. Several 100k lines. A GUID-only change has no meaning for a reviewer. The real identity of a type is `Namespace` + name.
- **Layout**: `BitOffs` alone is the biggest single source (>1M lines). Inserting one symbol shifts every following offset. Useful only when hunting for a moved address, so off by default.
- **Process image symbols**: symbols added/removed/renamed (`Name`), type (`BaseType` text), `Comment`, `Default` values (`Value`, `String`, `Bool`, `EnumText`, `DateTime`, `SubItem`), `Properties` (e.g. `TcAddressType`), `ArrayInfo`, `TcContextMask`, `DataArea/ContextId`. Areas: `PlcTask Inputs` (`InputDst`), `PlcTask Outputs` (`OutputSrc`), `Internal`. Identity: area name + symbol name.
- **Embedded data types**: types, `SubItem` members, `Method`s and parameters, enum values, array bounds added/removed/changed. Mostly follows from PLC code changes (the TMC was regenerated), so it duplicates what the ST diff of the PLC project shows. Useful when the PLC project is in another repo.
- **Instance parameters** (without build info): `Application Port`, `Application Name`, `Project Name`, `Symbolic Mapping`, `Auxtask Object Id`, task module names/OIDs/sort orders/ADI indices, `Task Caller OIDs`, `Mapping OIDs`; `Parameters` (PTCID) added/removed.
- **Unrestored links**: links TwinCAT could not restore (`RestoreInfo="ANotFound"`), with the IO path (`OwnerB`) and the PLC variable (`VarA`). Usually appears when a symbol was renamed or removed. A good warning to show even though links are otherwise out of scope.
- **Licenses**: `LicenseId` GUIDs added/removed, e.g. after using a new library function that needs a license. Could be shown with a readable name if a GUID -> name table is available.
- **Tasks**: task added/removed (`Context` with `Id`, `Name`, `Priority`, `CycleTime`, `ManualConfig/OTCID`), `DependOn`, `@NeedCalleeCall`, `TaskPouOids`. `CycleTime` is in 100 ns ticks (`10000000` = 1 s), show it in ms. A cycle time change is often part of a full rewrite and needs a real XML parse to be found.
- **Metadata**: `TmcHash` (= the TMC was regenerated, nearly every commit), `LastKnownRefactorCnt`, `TcVersion` (TwinCAT version pin/upgrade, ~3 % of commits, often with a full rewrite of the file).

## Conclusions for the implementation

1. **Parse the XML and compare by identity, not by line.** Use symbol = area + name, type = namespace + name, task = `Id`/`Name`, parameter = `Name`, license = `LicenseId`. A line diff cannot tell a moved block from a changed one, and it pairs offsets wrongly.
2. **Filter noise by default**, all as checkboxes (persisted):
   - GUID-only changes,
   - build info (list above, matched by parent `<Name>` and the `__TO_STRING__<n>` pattern),
   - timestamps/counters (`ImportTime`, `LastKnownRefactorCnt`, `TmcHash`),
   - whitespace / reordering.
3. **Category checkboxes**, defaults on: process image symbols, tasks, project/instance settings, instance parameters, licenses, unrestored links, embedded data types, other. Defaults off: layout, metadata. Show `TcVersion` even when metadata is off, or move it to settings.
4. **IO links**: not shown, only a one-line hint "N link changes, open the IO links diff".
5. **Order of the view**: rare but important categories first (tasks, settings, licenses, unrestored links), then symbols, then data types. Otherwise the few important changes disappear below hundreds of symbol changes.
6. Show a count of hidden changes per filter, so nothing disappears silently.

## Open questions

- Should embedded data types be shown at all when the PLC project lives in the same repo (the ST diff already covers it)?
- Should other `.xti` types (EtherCAT devices, NC axes, safety) and the `.tsproj` get the same view? They were not part of this survey.
- Is a GUID -> name table for licenses available?
