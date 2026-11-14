@echo off
rem Lance le serveur (sans ouvrir le navigateur) a chaque ouverture de session Windows.
rem Pour annuler : supprimez "Comptabilite Nowis (serveur).lnk" dans le dossier qui s'ouvre avec Win+R puis shell:startup
powershell -NoProfile -Command "$c=Join-Path '%~dp0' 'Demarrer.cmd'; $d=[Environment]::GetFolderPath('Startup'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut($d+'\Comptabilite Nowis (serveur).lnk'); $s.TargetPath=$c; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Save()"
if errorlevel 1 (echo Echec : le demarrage automatique n'a pas ete installe.) else (echo Le serveur demarrera automatiquement a la prochaine ouverture de session.)
pause
