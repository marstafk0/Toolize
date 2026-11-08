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
        EnrolledKey? saved = key;

        // Simulate a crash after the stick write but before the final commit is persisted:
        // only the first persist call (recording PendingHash before the stick write) lands.
        var step = 0;
        _ = Provider.Rotate(key, k =>
        {
            if (++step == 1) saved = k;
        });

        Assert.NotNull(saved!.PendingHash);
        Assert.Equal(key.Counter, saved.Counter);
        var check = Provider.Check([saved]);
        Assert.Equal(UnlockStatus.Verified, check.Status);
    }

    [Fact]
    public void Rotation_recorded_as_pending_survives_a_crash()
    {
        var drive = AddDrive("stick");
        var key = Provider.Enroll(drive, "key");

        // Whether the crash happened before the stick was written (old secret + counter K
        // on stick, PendingHash set in store) or after (new secret + counter K+1 on stick,
        // PendingHash set in store), the key still verifies — and an older clone with
        // counter < K is still caught as a clone.
        var beforeStickWrite = key with { PendingHash = Secrets.Hash(Secrets.NewSecret()) };
        Assert.Equal(UnlockStatus.Verified, Provider.Check([beforeStickWrite]).Status);

        var rotated = Provider.Rotate(key);
        var afterStickWrite = key with { PendingHash = rotated.SecretHash };
        Assert.Equal(UnlockStatus.Verified, Provider.Check([afterStickWrite]).Status);

        // PendingHash with wrong counter (e.g. counter K instead of K+1) is rejected.
        var wrongCounter = rotated with { Counter = rotated.Counter, SecretHash = key.SecretHash, PendingHash = rotated.SecretHash };
        Assert.Equal(UnlockStatus.Invalid, Provider.Check([wrongCounter]).Status);
    }

    [Fact]
    public void Rotation_persists_pending_before_committed_in_state_store()
    {
        var stateDir = Path.Combine(_root, "state");
        var store = new StateStore(stateDir);
        var drive = AddDrive("stick");
        var key = Provider.Enroll(drive, "key");
        store.AddKey(key);

        var snapshots = new List<EnrolledKey>();
        var final = Provider.Rotate(key, k =>
        {
            store.UpdateKey(k);
            snapshots.Add(store.Keys.Single());
        });

        Assert.Equal(2, snapshots.Count);
        Assert.Equal(1, snapshots[0].Counter);
        Assert.Equal(final.SecretHash, snapshots[0].PendingHash);
        Assert.Equal(2, snapshots[1].Counter);
        Assert.Null(snapshots[1].PendingHash);
        Assert.Equal(UnlockStatus.Verified, Provider.Check(store.Keys).Status);
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
