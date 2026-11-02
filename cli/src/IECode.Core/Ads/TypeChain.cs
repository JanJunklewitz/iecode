namespace IECode.Core.Ads;

/// <summary>Walks TwinCAT alias chains. Generic over the type object, so it is unit-tested without the Beckhoff assemblies.</summary>
public static class TypeChain
{
    /// <summary>
    /// The type that decides how a value is shown and parsed: aliases are followed down to their base type, but an enum
    /// ends the walk. Beckhoff's EnumType is also an alias of its base integer, so it must be tested as an enum first.
    /// null for null or a chain longer than <paramref name="maxDepth"/> (a cycle).
    /// </summary>
    public static T? Underlying<T>(T? type, Func<T, bool> isEnum, Func<T, T?> aliasBase, int maxDepth = 32) where T : class
    {
        for (var i = 0; type is not null && i < maxDepth; i++)
        {
            if (isEnum(type)) return type;
            if (aliasBase(type) is { } next) { type = next; continue; }
            return type;
        }
        return null;
    }
}
