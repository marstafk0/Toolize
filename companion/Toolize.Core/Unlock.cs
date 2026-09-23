using System.Security.Cryptography;

namespace Toolize.Core;

/// <summary>
/// A key enrolled to this machine. The secret itself never lives here — only the hash
/// of the secret currently expected on the drive.
/// </summary>
public sealed record EnrolledKey
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    /// <summary>Tier A (flash drive) or, later, Tier B (security key).</summary>
    public string Tier { get; init; } = "flash";
    /// <summary>SHA-256 of the secret we expect to find.</summary>
    public required string SecretHash { get; init; }
    /// <summary>
    /// Hash of a freshly written secret that hasn't been confirmed yet. Rotation writes
    /// the drive first and records the new hash second, so a crash in between must not
    /// lock the key out: either hash is accepted.
    /// </summary>
    public string? PendingHash { get; init; }
    /// <summary>Monotonic counter. A key presenting an older value is a clone.</summary>
    public long Counter { get; init; }
    public string? VolumeSerial { get; init; }
    public DateTimeOffset EnrolledAt { get; init; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? LastSeen { get; init; }
}

/// <summary>What gets written to the drive. Plain JSON — the point is friction, not secrecy.</summary>
public sealed record KeyFile
{
    public required string Id { get; init; }
    public required string Secret { get; init; }
    public required long Counter { get; init; }
    public string Note { get; init; } =
        "Toolize unlock key. Keep this drive with your accountability partner. " +
        "Copying this file does not create a second key: if both copies are ever used, Toolize notices.";
}

public enum UnlockStatus
{
    /// <summary>No key found on any attached drive.</summary>
    Absent,
    /// <summary>Key found and verified; weakening changes are allowed.</summary>
    Verified,
    /// <summary>A key file was found but its secret is wrong.</summary>
    Invalid,
    /// <summary>A stale counter: this drive is a copy of one that has been used since.</summary>
    Clone,
}

public sealed record UnlockCheck(UnlockStatus Status, EnrolledKey? Key = null, string? Detail = null);

/// <summary>
/// Tier A (flash drive) and, later, Tier B (FIDO2/YubiKey) sit behind this. Tier B
/// proves possession with a challenge the device answers internally; Tier A can only
/// prove that a file is present, which is why it rotates and counts.
/// </summary>
public interface IUnlockProvider
{
    string Tier { get; }
    /// <summary>Places a key could be enrolled to, for the picker.</summary>
    IReadOnlyList<DriveOption> Available();
    /// <summary>Looks for an enrolled key right now.</summary>
    UnlockCheck Check(IReadOnlyList<EnrolledKey> enrolled);
    /// <summary>Writes a new key to the given target and returns the record to store.</summary>
    EnrolledKey Enroll(string target, string name);
    /// <summary>
    /// Advances the secret so a copy taken earlier becomes detectable. Returns the
    /// updated record; the caller persists it.
    /// </summary>
    EnrolledKey Rotate(EnrolledKey key);
}

public static class Secrets
{
    public static string NewSecret() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));

    public static string Hash(string value) =>
        Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    /// <summary>A recovery code the user can write down: 4 groups of 5, unambiguous alphabet.</summary>
    public static string NewRecoveryCode()
    {
        const string alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
        var chars = RandomNumberGenerator.GetItems<char>(alphabet, 20);
        return string.Join('-', Enumerable.Range(0, 4).Select(i => new string(chars[(i * 5)..(i * 5 + 5)])));
    }

    public static string Normalise(string code) => code.Replace("-", "").Replace(" ", "").ToUpperInvariant();
}
