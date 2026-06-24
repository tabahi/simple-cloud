Set objShell = CreateObject("WScript.Shell")
strScript = Replace(WScript.ScriptFullName, WScript.ScriptName, "") & "..\src\index.js"
strNode = "node"
objShell.Run strNode & " """ & strScript & """", 0, False
