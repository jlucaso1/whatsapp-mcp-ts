$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
Set-Location "C:\Servicos\whatsapp-mcp"
& "C:\Program Files\nodejs\node.exe" triagem.js 2>&1 | Out-File "C:\Servicos\whatsapp-mcp\triagem-log.txt" -Encoding utf8
