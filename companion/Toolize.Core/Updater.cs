using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Toolize.Core;

/// <summary>The signed release manifest published with every GitHub release.</summary>
public sealed record UpdateManifest
{
    public required string Version { get; init; }
    public required string Channel { get; init; }
    public string? Notes { get; init; }
    public required string InstallerUrl { get; init; }
    public required string InstallerSha256 { get; init; }
    public string? ExtensionVersion { get; init; }
    public string? CrxUrl { get; init; }
}

/// <summary>
/// Self-update. The only outbound traffic the product makes, and it carries nothing but
/// a version and a channel name.
///
/// The update channel is a path straight into every installed machine, so trust here is
/// cryptographic, not transport-level: the manifest must carry a valid RSA signature
/// from the release key, and the installer must match the SHA-256 the manifest names.
/// A failure at either step aborts loudly and changes nothing.
/// </summary>
public sealed class Updater(string repo, string publicKeyBase64, string userAgent = "Toolize")
{
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromMinutes(10) };

    public async Task<UpdateManifest?> FetchManifestAsync(string channel, CancellationToken ct = default)
    {
        _http.DefaultRequestHeaders.UserAgent.ParseAdd(userAgent);
        var releases = await _http.GetFromJsonSafeAsync<List<GhRelease>>(
            $"https://api.github.com/repos/{repo}/releases?per_page=20", ct) ?? [];

        // dev sees prereleases and stable ones; stable only sees stable.
        var release = releases
            .Where(r => !r.Draft && (channel == "dev" || !r.Prerelease))
            .FirstOrDefault(r => r.Assets.Any(a => a.Name == ManifestName(channel)));
        if (release is null) return null;

        var manifestUrl = release.Assets.First(a => a.Name == ManifestName(channel)).BrowserDownloadUrl;
        var sigAsset = release.Assets.FirstOrDefault(a => a.Name == ManifestName(channel) + ".sig")
                       ?? throw new InvalidOperationException("release has no signature");

        var manifestBytes = await _http.GetByteArrayAsync(manifestUrl, ct);
        var signature = Convert.FromBase64String((await _http.GetStringAsync(sigAsset.BrowserDownloadUrl, ct)).Trim());
        if (!Verify(manifestBytes, signature))
            throw new InvalidOperationException("release manifest signature is not valid — refusing the update");

        return JsonSerializer.Deserialize<UpdateManifest>(manifestBytes, Protocol.Json);
    }

    public static string ManifestName(string channel) => $"update-{channel}.json";

    private bool Verify(byte[] data, byte[] signature)
    {
        try
        {
            using var rsa = RSA.Create();
            rsa.ImportSubjectPublicKeyInfo(Convert.FromBase64String(publicKeyBase64), out _);
            return rsa.VerifyData(data, signature, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Downloads the installer and checks its hash. Returns the file path.</summary>
    public async Task<string> DownloadInstallerAsync(UpdateManifest manifest, CancellationToken ct = default)
    {
        var target = Path.Combine(Path.GetTempPath(), $"Toolize-{manifest.Version}.exe");
        var bytes = await _http.GetByteArrayAsync(manifest.InstallerUrl, ct);
        var actual = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        if (!string.Equals(actual, manifest.InstallerSha256, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException($"installer hash mismatch (expected {manifest.InstallerSha256}, got {actual})");
        await File.WriteAllBytesAsync(target, bytes, ct);
        return target;
    }

    public static bool IsNewer(string candidate, string current) =>
        Version.TryParse(candidate, out var a) && Version.TryParse(current, out var b) && a > b;

    private sealed record GhRelease
    {
        [JsonPropertyName("tag_name")] public string TagName { get; init; } = "";
        public bool Draft { get; init; }
        public bool Prerelease { get; init; }
        public List<GhAsset> Assets { get; init; } = [];
    }

    private sealed record GhAsset
    {
        public string Name { get; init; } = "";
        [JsonPropertyName("browser_download_url")] public string BrowserDownloadUrl { get; init; } = "";
    }
}

internal static class HttpJson
{
    public static async Task<T?> GetFromJsonSafeAsync<T>(this HttpClient http, string url, CancellationToken ct)
    {
        using var response = await http.GetAsync(url, ct);
        response.EnsureSuccessStatusCode();
        return JsonSerializer.Deserialize<T>(await response.Content.ReadAsStringAsync(ct), new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
        });
    }
}

