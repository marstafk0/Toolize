using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Hosting.WindowsServices;
using Microsoft.Extensions.Logging;
using Toolize.Core;
using Toolize.Service;

// Toolize service. Runs as a Windows service in production; `--console` runs it in the
// foreground on a separate pipe and state directory so a dev build never fights the
// installed one.
var dev = args.Contains("--dev");
var console = args.Contains("--console") || dev;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(o => o.ServiceName = "Toolize");
builder.Logging.AddEventLog(o => o.SourceName = "Toolize");

builder.Services.AddSingleton(new StateStore(StateStore.DefaultDirectory(dev)));
builder.Services.AddSingleton<LockService>();
builder.Services.AddSingleton<ExtensionTracker>();
builder.Services.AddSingleton<UpdateService>();
builder.Services.AddSingleton<DoctorService>();
builder.Services.AddSingleton<RequestHandler>();
builder.Services.AddSingleton(sp => new PipeServer(
    Protocol.PipeName(dev),
    sp.GetRequiredService<RequestHandler>(),
    sp.GetRequiredService<ILogger<PipeServer>>()));
builder.Services.AddHostedService<ServiceWorker>();

var host = builder.Build();
if (console && !WindowsServiceHelpers.IsWindowsService())
    Console.WriteLine($"Toolize {AppInfo.Version} — pipe \\\\.\\pipe\\{Protocol.PipeName(dev)}, state {StateStore.DefaultDirectory(dev)}");
await host.RunAsync();

namespace Toolize.Service
{
    /// <summary>Owns the pipe server and the periodic update check.</summary>
    public sealed class ServiceWorker(
        PipeServer pipe,
        UpdateService updates,
        StateStore store,
        ILogger<ServiceWorker> log) : BackgroundService
    {
        private static readonly TimeSpan UpdateInterval = TimeSpan.FromHours(6);

        protected override async Task ExecuteAsync(CancellationToken ct)
        {
            log.LogInformation("Toolize {Version} starting, state in {Dir}", AppInfo.Version, store.Directory);
            var server = pipe.RunAsync(ct);

            // Check on start, then occasionally. Nothing installs itself: an update is
            // only applied when someone presses the button.
            while (!ct.IsCancellationRequested)
            {
                await updates.CheckAsync(ct);
                try
                {
                    await Task.Delay(UpdateInterval, ct);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
            await server;
        }
    }
}
