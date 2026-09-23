; Toolize installer. Built by tools/release.mjs, which supplies the defines below.
;
;   ISCC /DAppVersion=0.3.0 /DExtId=<id> /DUpdateXmlUrl=<url> /DSourceDir=<publish dir> toolize.iss
;
; What it installs: the service (SYSTEM), the GUI, the CLI, the native messaging host,
; and the packed extension. What it does NOT install: any lockdown. No forcelist, no
; watchdog, no incognito restrictions — see CLAUDE.md phase 3.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef ExtId
  #define ExtId "unknown"
#endif
#ifndef UpdateXmlUrl
  #define UpdateXmlUrl ""
#endif
#ifndef SourceDir
  #define SourceDir "..\out\app"
#endif

[Setup]
AppId={{8E2B0F94-6E07-4A35-9E5C-9B0A3E7A11C2}
AppName=Toolize
AppVersion={#AppVersion}
AppPublisher=Toolize
DefaultDirName={autopf}\Toolize
DefaultGroupName=Toolize
DisableProgramGroupPage=yes
OutputDir=..\out
OutputBaseFilename=Toolize-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName=Toolize {#AppVersion}
CloseApplications=yes

[Tasks]
Name: "installextension"; Description: "Install the Toolize browser extension automatically"; GroupDescription: "Browser"
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs
; Chrome refuses to load an unpacked extension from under Program Files, so the
; extension lives in ProgramData — where it can also be loaded by hand if needed.
Source: "{#SourceDir}\..\extension\*"; DestDir: "{commonappdata}\Toolize\extension"; Flags: ignoreversion recursesubdirs

[Icons]
Name: "{group}\Toolize"; Filename: "{app}\Toolize.Gui.exe"
Name: "{group}\Uninstall Toolize"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Toolize"; Filename: "{app}\Toolize.Gui.exe"; Tasks: desktopicon

[Registry]
; Native messaging: lets the extension talk to the service. Harmless on its own — it
; only works for the one extension ID listed in the manifest.
Root: HKLM; Subkey: "SOFTWARE\Google\Chrome\NativeMessagingHosts\com.toolize.host"; ValueType: string; ValueData: "{app}\com.toolize.host.json"; Flags: uninsdeletekey
Root: HKLM; Subkey: "SOFTWARE\Microsoft\Edge\NativeMessagingHosts\com.toolize.host"; ValueType: string; ValueData: "{app}\com.toolize.host.json"; Flags: uninsdeletekey
Root: HKLM; Subkey: "SOFTWARE\BraveSoftware\Brave\NativeMessagingHosts\com.toolize.host"; ValueType: string; ValueData: "{app}\com.toolize.host.json"; Flags: uninsdeletekey

; Extension install. `normal_installed` puts it in place and keeps it updated, but the
; user can still disable or remove it — it is a delivery mechanism, not a lock. The
; forcelist that makes it non-removable belongs to a later phase.
Root: HKLM; Subkey: "SOFTWARE\Policies\Google\Chrome\ExtensionSettings\{#ExtId}"; ValueType: string; ValueName: "installation_mode"; ValueData: "normal_installed"; Tasks: installextension; Flags: uninsdeletekey
Root: HKLM; Subkey: "SOFTWARE\Policies\Google\Chrome\ExtensionSettings\{#ExtId}"; ValueType: string; ValueName: "update_url"; ValueData: "{#UpdateXmlUrl}"; Tasks: installextension
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge\ExtensionSettings\{#ExtId}"; ValueType: string; ValueName: "installation_mode"; ValueData: "normal_installed"; Tasks: installextension; Flags: uninsdeletekey
Root: HKLM; Subkey: "SOFTWARE\Policies\Microsoft\Edge\ExtensionSettings\{#ExtId}"; ValueType: string; ValueName: "update_url"; ValueData: "{#UpdateXmlUrl}"; Tasks: installextension
Root: HKLM; Subkey: "SOFTWARE\Policies\BraveSoftware\Brave\ExtensionSettings\{#ExtId}"; ValueType: string; ValueName: "installation_mode"; ValueData: "normal_installed"; Tasks: installextension; Flags: uninsdeletekey
Root: HKLM; Subkey: "SOFTWARE\Policies\BraveSoftware\Brave\ExtensionSettings\{#ExtId}"; ValueType: string; ValueName: "update_url"; ValueData: "{#UpdateXmlUrl}"; Tasks: installextension

[Run]
Filename: "{sys}\sc.exe"; Parameters: "create Toolize binPath= ""{app}\Toolize.Service.exe"" start= auto DisplayName= ""Toolize"""; Flags: runhidden
Filename: "{sys}\sc.exe"; Parameters: "description Toolize ""Keeps Toolize's settings and talks to the browser extension."""; Flags: runhidden
; Restart the service on failure rather than leaving the browser unmanaged.
Filename: "{sys}\sc.exe"; Parameters: "failure Toolize reset= 86400 actions= restart/5000/restart/5000/restart/30000"; Flags: runhidden
Filename: "{sys}\sc.exe"; Parameters: "start Toolize"; Flags: runhidden
Filename: "{app}\Toolize.Gui.exe"; Description: "Open Toolize"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{sys}\sc.exe"; Parameters: "stop Toolize"; Flags: runhidden; RunOnceId: "StopService"
Filename: "{sys}\sc.exe"; Parameters: "delete Toolize"; Flags: runhidden; RunOnceId: "DeleteService"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"
Type: filesandordirs; Name: "{commonappdata}\Toolize\extension"

[Code]
// Inno's StringChangeEx returns a count, not the string; wrap it for readability.
function StringChangeEx2(const S, FromStr, ToStr: string; SupportDBCS: Boolean): string;
begin
  Result := S;
  StringChangeEx(Result, FromStr, ToStr, SupportDBCS);
end;

// The native messaging manifest has to carry an absolute path and the extension ID, so
// it is written at install time rather than shipped as a static file.
procedure WriteNativeHostManifest();
var
  Json: string;
begin
  Json :=
    '{' + #13#10 +
    '  "name": "com.toolize.host",' + #13#10 +
    '  "description": "Toolize native messaging host",' + #13#10 +
    '  "path": "' + StringChangeEx2(ExpandConstant('{app}\Toolize.NativeHost.exe'), '\', '\\', True) + '",' + #13#10 +
    '  "type": "stdio",' + #13#10 +
    '  "allowed_origins": ["chrome-extension://{#ExtId}/"]' + #13#10 +
    '}';
  SaveStringToFile(ExpandConstant('{app}\com.toolize.host.json'), Json, False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    WriteNativeHostManifest();
end;

// An update installs over a running service, so stop it before the files are replaced.
function PrepareToInstall(var NeedsRestart: Boolean): string;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\sc.exe'), 'stop Toolize', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(1500);
  Result := '';
end;
