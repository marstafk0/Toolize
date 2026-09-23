namespace Toolize.Core;

/// <summary>What `status` returns — everything a client needs to render, in one round trip.</summary>
public sealed record StatusReport
{
    public required string Version { get; init; }
    public required string Channel { get; init; }
    public required Settings Settings { get; init; }
    public required LockState Lock { get; init; }
    public required ExtensionState Extension { get; init; }
    public UpdateInfo? Update { get; init; }
    public IReadOnlyList<string> Notes { get; init; } = [];
}

/// <summary>
/// Phase 3 ships with no key enrolled, so nothing is locked and every change is allowed.
/// The plumbing is here so phase 4 only has to supply a real provider.
/// </summary>
public sealed record LockState
{
    public bool Enrolled { get; init; }
    public bool KeyPresent { get; init; }
    /// <summary>False when a weakening change would be refused right now.</summary>
    public bool CanWeaken => !Enrolled || KeyPresent;
    public string? KeyName { get; init; }
}

public sealed record ExtensionState
{
    public bool Connected { get; init; }
    public string? Version { get; init; }
    public DateTimeOffset? LastSeen { get; init; }
    public int Blocked { get; init; }
    public int Checked { get; init; }
}

public sealed record UpdateInfo
{
    public required string Version { get; init; }
    public bool Available { get; init; }
    public string? Notes { get; init; }
    public string? InstallerUrl { get; init; }
    public string? Sha256 { get; init; }
}

/// <summary>One line of a `doctor` report: a check, its verdict, and what to do about it.</summary>
public sealed record Check(string Name, bool Ok, string Detail, string? Fix = null);

public sealed record SetSettingsArgs(Settings Settings);

public sealed record SetChannelArgs(string Channel);

public sealed record ExtensionHelloArgs(string Version);

public sealed record ExtensionHeartbeatArgs(string Version, int Blocked, int Checked);
