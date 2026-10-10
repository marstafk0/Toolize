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
    public IReadOnlyList<EnrolledKey> Keys { get; init; } = [];
    public EnforcementState Enforcement { get; init; } = new();
    public bool HasRecoveryCode { get; init; }
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
    /// <summary>Which browsers have checked in recently — the watchdog judges each one separately.</summary>
    public IReadOnlyList<string> Browsers { get; init; } = [];
}

/// <summary>What enforcement is doing right now, for the GUI and doctor.</summary>
public sealed record EnforcementState
{
    public bool Applied { get; init; }
    public string Summary { get; init; } = "not enforced";
    public string Watchdog { get; init; } = "off";
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

public sealed record EnrollKeyArgs(string Drive, string Name);

public sealed record RevokeKeyArgs(string Id);

public sealed record RecoverArgs(string Code);

/// <summary>Browser is "chrome", "edge" or "brave"; null from extensions older than 0.5.3.</summary>
public sealed record ExtensionHelloArgs(string Version, string? Browser = null);

public sealed record ExtensionHeartbeatArgs(string Version, int Blocked, int Checked, string? Browser = null);
