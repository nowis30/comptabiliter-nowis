@echo off
rem Cree un raccourci "Comptabilite Nowis" sur le bureau. Ne modifie rien d'autre.
powershell -NoProfile -Command "$c=Join-Path '%~dp0' 'Demarrer.cmd'; $d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut($d+'\Comptabilite Nowis.lnk'); $s.TargetPath=$c; $s.Arguments='--ouvrir'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Save()"
if errorlevel 1 (echo Le raccourci n'a pas pu etre cree. Double-cliquez plutot sur Demarrer.cmd.) else (echo Raccourci cree sur le bureau : Comptabilite Nowis)
pause
