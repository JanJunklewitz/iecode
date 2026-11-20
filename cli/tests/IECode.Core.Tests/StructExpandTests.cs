using IECode.Core.Ads;

namespace IECode.Core.Tests;

public sealed class StructExpandTests
{
    private sealed record N(string Path, NodeKind Kind, params N[] Kids);

    private static StructWalk<N> Walk(N root, int depth = 3, int maxMembers = 200, int maxElements = 20) =>
        StructExpand.Walk(root, depth, maxMembers, maxElements, n => n.Kind, n => n.Kids, n => n.Path);

    private static N Leaf(string p) => new(p, NodeKind.Leaf);

    [Fact]
    public void Leaves_come_depth_first_in_declaration_order()
    {
        var root = new N("r", NodeKind.Struct, Leaf("r.a"), new N("r.s", NodeKind.Struct, Leaf("r.s.b"), Leaf("r.s.c")), Leaf("r.d"));
        Assert.Equal(["r.a", "r.s.b", "r.s.c", "r.d"], Walk(root).Leaves.Select(l => l.Path));
    }

    [Fact]
    public void Depth_limit_marks_deeper_structs_as_not_expanded()
    {
        var root = new N("r", NodeKind.Struct, Leaf("r.a"), new N("r.s", NodeKind.Struct, Leaf("r.s.b")));
        var walk = Walk(root, depth: 1);
        Assert.Equal(["r.a"], walk.Leaves.Select(l => l.Path));
        Assert.Equal(["r.s (depth limit)"], walk.NotExpanded);
    }

    [Fact]
    public void Arrays_show_the_first_elements_and_count_the_rest()
    {
        var root = new N("r", NodeKind.Array, Enumerable.Range(0, 25).Select(i => Leaf($"r[{i}]")).ToArray());
        var walk = Walk(root);
        Assert.Equal(20, walk.Leaves.Count);
        Assert.Equal(5, walk.OmittedElements);
    }

    [Fact]
    public void The_member_cap_counts_what_it_leaves_out()
    {
        var root = new N("r", NodeKind.Struct, Enumerable.Range(0, 5000).Select(i => Leaf($"r.m{i}")).ToArray());
        var walk = Walk(root);
        Assert.Equal(200, walk.Leaves.Count);
        Assert.Equal(4800, walk.OmittedMembers);
    }

    [Fact]
    public void Pointers_and_references_are_not_expanded()
    {
        var root = new N("r", NodeKind.Struct, Leaf("r.a"), new N("pNext", NodeKind.Opaque));
        Assert.Equal(["pNext (pointer or reference)"], Walk(root).NotExpanded);
    }

    [Fact]
    public void A_single_value_root_is_its_own_leaf()
    {
        var walk = Walk(Leaf("r"));
        Assert.Equal(["r"], walk.Leaves.Select(l => l.Path));
        Assert.Empty(walk.NotExpanded);
    }

    [Fact]
    public void The_not_expanded_list_is_capped()
    {
        var root = new N("r", NodeKind.Struct, Enumerable.Range(0, 50).Select(i => new N($"p{i}", NodeKind.Opaque)).ToArray());
        Assert.Equal(StructExpand.MaxNotExpanded, Walk(root).NotExpanded.Count);
    }
}
