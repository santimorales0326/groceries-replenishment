@echo off
echo ========================================================
echo   PantryPulse - Allow Wi-Fi / Local Network Access
echo ========================================================
echo.
echo 1. Adding Windows Firewall inbound rule for port 8000...
netsh advfirewall firewall add rule name="PantryPulse Port 8000" dir=in action=allow protocol=TCP localport=8000 profile=any
echo.
echo 2. Setting Wi-Fi network profile to Private...
powershell -Command "Get-NetConnectionProfile | Where-Object { $_.InterfaceAlias -eq 'Wi-Fi' } | Set-NetConnectionProfile -NetworkCategory Private"
echo.
echo ========================================================
echo Configuration complete!
echo Your phone can now access: http://192.168.1.133:8000
echo ========================================================
echo.
pause
