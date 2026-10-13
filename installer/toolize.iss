; Toolize installer. Built by tools/release.mjs, which supplies the defines below.
;
;   ISCC /DAppVersion=0.3.0 /DExtId=<id> /DUpdateXmlUrl=<url> /DSourceDir=<publish dir> toolize.iss
;
; What it installs: the service (SYSTEM), the GUI, the CLI, the native messaging host,
; and the packed extension. What it does NOT install: any lockdown. Browser policy
; (forcelist, incognito off, other extensions blocked) is written by the service when the
; user turns enforcement on, and removed here on uninstall — see RemoveEnforcementPolicy.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef ExtId
  #define ExtId "unknown"
#endif
; The Web Store assigns its own id. When it's known, both are allowed to talk to the
; service, so a store-installed extension and a locally loaded dev build both work.
#ifndef StoreExtId
  #define StoreExtId ""
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
; Restart Manager can't close a window in the user's session when setup runs from the
; service in session 0, so don't rely on it — PrepareToInstall below closes our own apps
; directly. Leaving this on meant a silent update aborted whenever the GUI was open,
; which is most of the time, since that is where the update button lives.
CloseApplications=no
RestartApplications=no

[Tasks]
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

[Run]
Filename: "{sys}\sc.exe"; Parameters: "create Toolize binPath= ""{app}\Toolize.Service.exe"" start= auto DisplayName= ""Toolize"""; Flags: runhidden
Filename: "{sys}\sc.exe"; Parameters: "description Toolize ""Keeps Toolize's settings and talks to the browser extension."""; Flags: runhidden
; Restart the service on failure rather than leaving the browser unmanaged.
Filename: "{sys}\sc.exe"; Parameters: "failure Toolize reset= 86400 actions= restart/5000/restart/5000/restart/30000"; Flags: runhidden
Filename: "{sys}\sc.exe"; Parameters: "start Toolize"; Flags: runhidden
Filename: "{app}\Toolize.Gui.exe"; Description: "Open Toolize"; Flags: postinstall nowait skipifsilent
; The extension is an ordinary Web Store install: the user adds it, and can remove it.
; Only enforcement (written by the service, gated by the key) locks it in place. A
; policy-based install here would lock it too — normal_installed hides Remove — which
; made "enforcement off" a lie.
Filename: "https://chromewebstore.google.com/detail/{#StoreExtId}"; Description: "Add the Toolize extension to your browser"; Flags: postinstall shellexec nowait skipifsilent; Check: HasStoreId

[UninstallRun]
Filename: "{sys}\sc.exe"; Parameters: "stop Toolize"; Flags: runhidden; RunOnceId: "StopService"
Filename: "{sys}\sc.exe"; Parameters: "delete Toolize"; Flags: runhidden; RunOnceId: "DeleteService"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"
Type: filesandordirs; Name: "{commonappdata}\Toolize\extension"

[Code]
var
  // Set once PrepareToInstall has stopped the service, and once the files are in.
  // If the first is true and the second isn't, setup failed or was cancelled midway.
  ServiceStopped: Boolean;
  Installed: Boolean;
  // Programs moved aside before the copy, as "original=moved" pairs (see MoveAsideBinaries).
  MovedAside: TStringList;

// The browser can start Toolize.NativeHost.exe again at any moment (it bridges the
// extension to the service), and anything still running keeps its .exe and .dlls
// locked, so copying over them failed and left a half-updated install: a new CLI
// next to an old Toolize.Core.dll, which then wouldn't start. Windows lets a file in
// use be renamed, so every program file is moved aside first and the copy never meets
// a locked file. The moved copies are deleted afterwards, or on the next update if
// something still has them open.
procedure MoveAsideBinaries();
var
  FindRec: TFindRec;
  Dir, Name, Ext, Moved: String;
  N: Integer;
begin
  MovedAside := TStringList.Create;
  Dir := ExpandConstant('{app}');
  if FindFirst(Dir + '\*.old', FindRec) then
  try
    repeat
      DeleteFile(Dir + '\' + FindRec.Name); // leftovers from the last update
    until not FindNext(FindRec);
  finally
    FindClose(FindRec);
  end;
  if FindFirst(Dir + '\*', FindRec) then
  try
    repeat
      Name := FindRec.Name;
      Ext := Lowercase(ExtractFileExt(Name));
      if ((Ext = '.exe') or (Ext = '.dll')) and (Pos('unins', Lowercase(Name)) <> 1) then
      begin
        N := 0;
        repeat
          N := N + 1;
          Moved := Dir + '\' + Name + '.' + IntToStr(N) + '.old';
        until not FileExists(Moved);
        if RenameFile(Dir + '\' + Name, Moved) then
          MovedAside.Add(Dir + '\' + Name + '=' + Moved);
      end;
    until not FindNext(FindRec);
  finally
    FindClose(FindRec);
  end;
end;

// Setup failed after moving the old programs aside: put them back exactly, replacing
// anything half-copied, so the old version runs as before.
procedure RestoreMovedAside();
var
  I: Integer;
  Original: String;
begin
  if MovedAside = nil then exit;
  for I := 0 to MovedAside.Count - 1 do
  begin
    Original := MovedAside.Names[I];
    DeleteFile(Original);
    RenameFile(MovedAside.ValueFromIndex[I], Original);
  end;
end;

// Installed fine: the moved-aside copies can go (ones still in use stay until next time).
procedure DeleteMovedAside();
var
  I: Integer;
begin
  if MovedAside = nil then exit;
  for I := 0 to MovedAside.Count - 1 do
    DeleteFile(MovedAside.ValueFromIndex[I]);
end;

// Inno's StringChangeEx returns a count, not the string; wrap it for readability.
function StringChangeEx2(const S, FromStr, ToStr: string; SupportDBCS: Boolean): string;
begin
  Result := S;
  StringChangeEx(Result, FromStr, ToStr, SupportDBCS);
end;

// The native messaging manifest has to carry an absolute path and the extension ID, so
// it is written at install time rather than shipped as a static file.
function AllowedOrigins(): string;
begin
  Result := '"chrome-extension://{#ExtId}/"';
  if '{#StoreExtId}' <> '' then
    Result := Result + ', "chrome-extension://{#StoreExtId}/"';
end;

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
    '  "allowed_origins": [' + AllowedOrigins + ']' + #13#10 +
    '}';
  SaveStringToFile(ExpandConstant('{app}\com.toolize.host.json'), Json, False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    WriteNativeHostManifest();
    Installed := True;
    DeleteMovedAside();
  end;
end;

// A failed update must never leave the machine unprotected. Setup stops the service
// before replacing files; if it then aborts (a file in use, a cancelled UAC prompt, a
// crash in the middle), the old files are still in place, so start the old service
// again. Without this, protection stayed off until the next reboot.
procedure DeinitializeSetup();
var
  ResultCode: Integer;
begin
  if ServiceStopped and not Installed then
  begin
    RestoreMovedAside();
    Exec(ExpandConstant('{sys}\sc.exe'), 'start Toolize', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;

function HasStoreId(): Boolean;
begin
  Result := '{#StoreExtId}' <> '';
end;

// Uninstalling is a weakening change, so it needs the key. The CLI answers: 0 = allowed,
// 4 = locked. Anything else (service missing or broken) allows removal — a half-dead
// install must still be removable, or the only way out would be editing the registry.
function InitializeUninstall(): Boolean;
var
  ResultCode: Integer;
  Cli: string;
begin
  Result := True;
  Cli := ExpandConstant('{app}\Toolize.Cli.exe');
  if not FileExists(Cli) then Exit;
  if not Exec(Cli, 'uninstall-check', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then Exit;
  if ResultCode = 4 then
  begin
    MsgBox('Plug in your Toolize unlock key before uninstalling.', mbError, MB_OK);
    Result := False;
  end;
end;

// The service writes browser policy while enforcement is on, and uninstalling removes the
// service — so the policy has to go with it. Left behind, every browser would stay
// locked down (other extensions blocked, private windows and DevTools off) with nothing
// on the machine able to turn it off. Runs after the service is stopped, so it can't be
// put back by a reconcile pass. Mirrors PolicyPlan.AllOwned in Toolize.Core/Enforcement.cs.
procedure RemoveEnforcementPolicy(const Root: string);
var
  Forced: string;
begin
  RegDeleteValue(HKLM, Root, 'IncognitoModeAvailability');
  RegDeleteValue(HKLM, Root, 'InPrivateModeAvailability');
  RegDeleteValue(HKLM, Root, 'BrowserGuestModeEnabled');
  RegDeleteValue(HKLM, Root, 'BrowserAddPersonEnabled');
  RegDeleteValue(HKLM, Root, 'TorDisabled');
  RegDeleteValue(HKLM, Root, 'DeveloperToolsAvailability');
  RegDeleteValue(HKLM, Root, 'ExtensionSettings'); // JSON form written by 0.5.x dev builds
  // Only our own forcelist entry; anything else an admin put there stays.
  if HasStoreId() and RegQueryStringValue(HKLM, Root + '\ExtensionInstallForcelist', '1', Forced)
    and (Pos('{#StoreExtId};', Forced) = 1) then
    RegDeleteValue(HKLM, Root + '\ExtensionInstallForcelist', '1');
  RegDeleteKeyIfEmpty(HKLM, Root + '\ExtensionInstallForcelist');
  RegDeleteKeyIncludingSubkeys(HKLM, Root + '\ExtensionSettings\*');
  if HasStoreId() then
    RegDeleteKeyIncludingSubkeys(HKLM, Root + '\ExtensionSettings\{#StoreExtId}');
  RegDeleteKeyIfEmpty(HKLM, Root + '\ExtensionSettings');
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    RemoveEnforcementPolicy('SOFTWARE\Policies\Google\Chrome');
    RemoveEnforcementPolicy('SOFTWARE\Policies\Microsoft\Edge');
    RemoveEnforcementPolicy('SOFTWARE\Policies\BraveSoftware\Brave');
  end;
end;

// An update installs over a running service and, usually, over a running GUI: the
// update button is in it. Setup may be launched by the service in session 0, where
// Restart Manager cannot touch the user's windows, so close our own processes here.
// Only ever our own — nothing else on the machine is disturbed.
function PrepareToInstall(var NeedsRestart: Boolean): string;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\sc.exe'), 'stop Toolize', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  ServiceStopped := True;
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM Toolize.Gui.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM Toolize.Cli.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM Toolize.NativeHost.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(1500);
  MoveAsideBinaries();
  Result := '';
end;
