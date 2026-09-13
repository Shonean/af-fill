' Generate desktop shortcut with Ctrl+Alt+A hotkey (ASCII-only source: WSH reads .vbs as ANSI/GBK,
' so any non-ASCII literal would get mangled - Chinese strings are built with ChrW codes).
' Rerun anytime to (re)create the shortcut. Browser preference: Edge (user's daily browser, has
' Tampermonkey), else Chrome.
Dim shell, fso, target, edgePaths, chromePaths, p, lnk, name
name = ChrW(32593) & ChrW(30003) & ChrW(24555) & ChrW(22635) ' wang-shen-kuai-tian

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
target = ""

edgePaths = Array( _
  shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe", _
  shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe")

For Each p In edgePaths
  If fso.FileExists(p) Then
    target = p
    Exit For
  End If
Next

If target = "" Then
  chromePaths = Array( _
    shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\Google\Chrome\Application\chrome.exe", _
    shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Google\Chrome\Application\chrome.exe", _
    shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Google\Chrome\Application\chrome.exe")
  For Each p In chromePaths
    If fso.FileExists(p) Then
      target = p
      Exit For
    End If
  Next
End If

If target = "" Then target = "msedge.exe"

Set lnk = shell.CreateShortcut(shell.SpecialFolders("Desktop") & "\" & name & ".lnk")
lnk.TargetPath = target
lnk.Arguments = "https://job.chinatelecom.com.cn/wt/TELE/web/index?brandCode=1"
lnk.Description = "AF-Fill"
lnk.Hotkey = "CTRL+ALT+A"
lnk.Save

WScript.Echo "OK: " & target & " -> hotkey CTRL+ALT+A"
