' AF-Fill driver: create desktop shortcut "Job Edge" -> dedicated Edge profile with CDP port
Set ws = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
desk = ws.SpecialFolders("Desktop")
Set lnk = ws.CreateShortcut(desk & "\Job Edge.lnk")
lnk.TargetPath = "powershell.exe"
lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -File """ & dir & "\af_edge.ps1"""
lnk.WorkingDirectory = dir
lnk.IconLocation = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe,0"
lnk.Description = "AF-Fill dedicated Edge profile (debug port 9222)"
lnk.Save
MsgBox "Desktop shortcut created: Job Edge", vbInformation, "AF-Fill"
