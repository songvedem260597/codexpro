Option Explicit

Dim shell, args, workingDirectory, executable, commandLine, index
Set shell = CreateObject("WScript.Shell")
Set args = WScript.Arguments

If args.Count < 2 Then
  WScript.Quit 2
End If

workingDirectory = CStr(args(0))
executable = CStr(args(1))

If Len(workingDirectory) > 0 Then
  shell.CurrentDirectory = workingDirectory
End If

shell.Environment("PROCESS")("CODEXPRO_HIDDEN_LAUNCHER") = "1"
commandLine = QuoteArgument(executable)
For index = 2 To args.Count - 1
  commandLine = commandLine & " " & QuoteArgument(CStr(args(index)))
Next

' Window style 0 keeps console-subsystem children completely hidden.
' True keeps wscript attached to the Scheduled Task for CodexPro's lifetime.
' The window still stays completely hidden because window style is 0.
shell.Run commandLine, 0, True

Function QuoteArgument(value)
  QuoteArgument = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
