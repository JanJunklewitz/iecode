namespace IECode.Core.Mcp;

/// <summary>What happened when a window was probed (pipe connect plus handshake).</summary>
public abstract record Probe
{
    /// <summary>Connected and authenticated.</summary>
    public sealed record Ok(Stream Link) : Probe;
    /// <summary>The pipe does not exist or refuses: the window is gone.</summary>
    public sealed record Absent : Probe;
    /// <summary>Timed out, closed early, sent a malformed line or a wrong proof: the state is unknown.</summary>
    public sealed record Silent : Probe;
}

/// <summary>The window a folder's calls go to, or why there is none.</summary>
public abstract record Selection
{
    public sealed record Chosen(InstanceInfo Instance) : Selection;
    public sealed record None : Selection;
    public sealed record Conflict(IReadOnlyList<InstanceInfo> Instances) : Selection;
    public sealed record VersionMismatch(InstanceInfo Instance) : Selection;
    /// <summary>A matching window did not answer in time (paused, busy): it may still own the folder, so nothing is sent anywhere.</summary>
    public sealed record Unsure(IReadOnlyList<InstanceInfo> Instances) : Selection;

    /// <summary>
    /// Candidates are instances with a root that contains <paramref name="cwd"/>. The groups of equal best-root length are walked from the
    /// longest; a group decides as soon as one of its windows is reachable or silent. Silent never means gone, so a paused window with the
    /// longest root blocks the fallback to a shorter root. The streams of the probes are disposed: a caller that keeps a link holds its own.
    /// </summary>
    public static Selection Choose(string cwd, IReadOnlyList<InstanceInfo> all, Func<InstanceInfo, Probe> connect)
    {
        var groups = new List<(int Length, List<InstanceInfo> Members)>();
        foreach (var inst in all)
        {
            var best = -1;
            foreach (var root in inst.Roots)
            {
                if (PathMatch.Contains(root, cwd)) best = Math.Max(best, PathMatch.Canonical(root).Length);
            }
            if (best < 0) continue;
            // a window that speaks another protocol version still takes part in its group: it may own the folder, so nothing goes past it
            var group = groups.FirstOrDefault(g => g.Length == best);
            if (group.Members is null) groups.Add((best, new List<InstanceInfo> { inst }));
            else group.Members.Add(inst);
        }

        foreach (var (_, members) in groups.OrderByDescending(g => g.Length))
        {
            // a lone window is probed on this thread (no nested pool work); several are probed in parallel so paused ones do not add their timeouts up
            var probes = members.Count == 1
                ? [SafeConnect(connect, members[0])]
                : Task.WhenAll(members.Select(m => Task.Run(() => SafeConnect(connect, m)))).GetAwaiter().GetResult();
            var ok = new List<(InstanceInfo Instance, Stream Link)>();
            var silent = new List<InstanceInfo>();
            InstanceInfo? mismatch = null;
            for (var i = 0; i < members.Count; i++)
            {
                var compatible = members[i].ProtocolMin <= Wire.Protocol && Wire.Protocol <= members[i].ProtocolMax;
                switch (probes[i])
                {
                    case Probe.Ok o when compatible: ok.Add((members[i], o.Link)); break;
                    case Probe.Ok o: o.Link.Dispose(); mismatch ??= members[i]; break;
                    case Probe.Silent: silent.Add(members[i]); break;
                }
            }
            if (silent.Count > 0)
            {
                foreach (var o in ok) o.Link.Dispose();
                return new Unsure(silent);
            }
            if (mismatch is not null)
            {
                foreach (var o in ok) o.Link.Dispose();
                return new VersionMismatch(mismatch);
            }
            if (ok.Count == 1)
            {
                ok[0].Link.Dispose();
                return new Chosen(ok[0].Instance);
            }
            if (ok.Count > 1)
            {
                foreach (var o in ok) o.Link.Dispose();
                return new Conflict(ok.Select(o => o.Instance).ToList());
            }
            // only absent windows: the folder is not served by this group, try the shorter roots
        }
        return new None();
    }

    /// <summary>A probe that throws is unknown, not gone.</summary>
    private static Probe SafeConnect(Func<InstanceInfo, Probe> connect, InstanceInfo inst)
    {
        try { return connect(inst); }
        catch (Exception) { return new Probe.Silent(); }
    }
}
