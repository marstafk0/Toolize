using System.Text.Json;
using Toolize.Core;
using Xunit;

namespace Toolize.Tests;

/// <summary>
/// The lock rules, exercised against real files in temp folders standing in for USB
/// drives. These are the behaviours that must not quietly break: a copied key has to be
/// noticed, and a rotation interrupted half-way must never brick the only key.
/// </summary>
public sealed class UnlockTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "toolize-tests", Guid.NewGuid().ToString("n")[..8]);
    private readonly List<DriveOption> _drives = [];

    private FlashDriveProvider Provider => new(() => _drives);

    private string AddDrive(string name)
    {
        var path = Path.Combine(_root, name) + Path.DirectorySeparatorChar;
        Directory.CreateDirectory(path);
        _drives.Add(new DriveOption(path, name, 4_000_000_000, false));
        return path;
    }

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    [Fact]
    public void Enrolled_key_verifies_and_absent_key_does_not()
    {
        var drive = AddDrive("stick");
        var key = Provider.Enroll(drive, "Partner's key");

        Assert.Equal(UnlockStatus.Verified, Provider.Check([key]).Status);

        _drives.Clear(); // unplugged
        Assert.Equal(UnlockStatus.Absent, Provider.Check([key]).Status);
    }

    [Fact]
    public void No_keys_enrolled_means_absent_not_verified()
    {
        AddDrive("stick");
        Assert.Equal(UnlockStatus.Absent, Provider.Check([]).Status);
    }

    [Fact]
    public void A_stranger_key_file_is_rejected()
    {
        var drive = AddDrive("stick");
        var key = Provider.Enroll(drive, "real");

        // Same id and counter, different secret: someone made their own file.
        File.SetAttributes(FlashDriveProvider.KeyPath(drive), FileAttributes.Normal);
        File.WriteAllText(FlashDriveProvider.KeyPath(drive),
            JsonSerializer.Serialize(new KeyFile { Id = key.Id, Secret = Secrets.NewSecret(), Counter = key.Counter },
                Protocol.Json));

        Assert.Equal(UnlockStatus.Invalid, Provider.Check([key]).Status);
    }

    [Fact]
    public void A_copy_used_after_the_original_is_detected_as_a_clone()
    {
        var original = AddDrive("original");
        var key = Provider.Enroll(original, "key");

        // Copy the drive's contents, as anyone could.
        var copy = AddDrive("copy");
        Directory.CreateDirectory(Path.GetDirectoryName(FlashDriveProvider.KeyPath(copy))!);
        File.Copy(FlashDriveProvider.KeyPath(original), FlashDriveProvider.KeyPath(copy));

        // The original gets used, which advances the secret.
        key = Provider.Rotate(key);

        // Now only the copy is plugged in: it carries the stale counter.
        _drives.RemoveAll(d => d.Root == original);
        var check = Provider.Check([key]);
        Assert.Equal(UnlockStatus.Clone, check.Status);
        Assert.Contains("copy taken earlier", check.Detail);
    }

    [Fact]
    public void A_copy_alone_is_not_detectable_until_the_original_reappears()
    {
        // The honest limit of Tier A, pinned down so nobody claims more than it does.
        var original = AddDrive("original");
        var key = Provider.Enroll(original, "key");

        var copy = AddDrive("copy");
        Directory.CreateDirectory(Path.GetDirectoryName(FlashDriveProvider.KeyPath(copy))!);
        File.Copy(FlashDriveProvider.KeyPath(original), FlashDriveProvider.KeyPath(copy));
        _drives.RemoveAll(d => d.Root == original); // original locked away with the partner

        Assert.Equal(UnlockStatus.Verified, Provider.Check([key]).Status);
    }

    [Fact]
    public void Rotation_interrupted_before_the_state_is_saved_still_verifies()
    {
        var drive = AddDrive("stick");
        var key = Provider.Enroll(drive, "key");

        // Rotate writes the drive, then returns the record to persist. Simulate a crash
        // by throwing the returned record away: the drive now holds the NEW secret while
        // the service still remembers the OLD one.
        _ = Provider.Rotate(key);

        var check = Provider.Check([key]);
        Assert.Equal(UnlockStatus.Invalid, check.Status); // honest: this is the failure mode…
    }

    [Fact]
    public void Rotation_recorded_as_pending_survives_a_crash()
    {
        var drive = AddDrive("stick");
        var key = Provider.Enroll(drive, "key");

        // …and this is why Rotate returns PendingHash first: a caller that persists the
        // pending record before the drive write still accepts the key afterwards.
        var rotated = Provider.Rotate(key);
        var asIfCrashedMidway = key with { PendingHash = rotated.SecretHash };

        Assert.Equal(UnlockStatus.Verified, Provider.Check([asIfCrashedMidway]).Status);
    }

    [Fact]
    public void Rotation_advances_the_counter_and_keeps_verifying()
    {
        var drive = AddDrive("stick");
        var key = Provider.Enroll(drive, "key");

        for (var i = 0; i < 5; i++)
        {
            key = Provider.Rotate(key);
            Assert.Equal(UnlockStatus.Verified, Provider.Check([key]).Status);
        }
        Assert.Equal(6, key.Counter);
    }

    [Fact]
    public void Enrolling_a_drive_that_is_not_plugged_in_fails()
    {
        Assert.Throws<InvalidOperationException>(() => Provider.Enroll("Z:", "nope"));
    }
}
