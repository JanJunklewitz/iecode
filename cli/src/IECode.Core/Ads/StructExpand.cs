namespace IECode.Core.Ads;

/// <summary>What a node of a symbol tree is for a read: a value, a container to enter, or something that is never entered.</summary>
public enum NodeKind { Leaf, Struct, Array, Opaque }

/// <summary>The leaves of a walk in declaration order and what the walk left out, so a capped list is never taken for the whole.</summary>
public sealed record StructWalk<T>(IReadOnlyList<T> Leaves, int OmittedMembers, int OmittedElements, IReadOnlyList<string> NotExpanded);

/// <summary>Walks a symbol tree down to its value leaves with a depth limit and caps; pure, the tree comes in through delegates.</summary>
public static class StructExpand
{
    public const int DefaultDepth = 3, MaxDepth = 5, MaxMembers = 200, MaxElements = 20, MaxNotExpanded = 20;

    /// <summary>
    /// The children of the root are level 1. A struct or array child at level L is entered when L &lt; depth, otherwise its path is
    /// listed as "(depth limit)"; an opaque node (pointer, reference, interface) is listed as "(pointer or reference)". An array
    /// enters its first <paramref name="maxElements"/> children and counts the rest; once <paramref name="maxMembers"/> leaves are
    /// collected, further leaves only count. A leaf root is its own single leaf.
    /// </summary>
    public static StructWalk<T> Walk<T>(T root, int depth, int maxMembers, int maxElements,
        Func<T, NodeKind> kind, Func<T, IReadOnlyList<T>> children, Func<T, string> path)
    {
        var leaves = new List<T>();
        var notExpanded = new List<string>();
        int omittedMembers = 0, omittedElements = 0;

        void Note(string text)
        {
            if (notExpanded.Count < MaxNotExpanded) notExpanded.Add(text);
        }

        void Visit(T node, int level)
        {
            var kids = children(node);
            var take = kind(node) == NodeKind.Array ? Math.Min(kids.Count, maxElements) : kids.Count;
            if (take < kids.Count) omittedElements += kids.Count - take;
            for (var i = 0; i < take; i++)
            {
                var child = kids[i];
                switch (kind(child))
                {
                    case NodeKind.Leaf:
                        if (leaves.Count < maxMembers) leaves.Add(child);
                        else omittedMembers++;
                        break;
                    case NodeKind.Opaque:
                        Note($"{path(child)} (pointer or reference)");
                        break;
                    default:
                        if (level < depth) Visit(child, level + 1);
                        else Note($"{path(child)} (depth limit)");
                        break;
                }
            }
        }

        if (kind(root) == NodeKind.Leaf) leaves.Add(root);
        else if (kind(root) == NodeKind.Opaque) Note($"{path(root)} (pointer or reference)");
        else Visit(root, 1);
        return new StructWalk<T>(leaves, omittedMembers, omittedElements, notExpanded);
    }
}
