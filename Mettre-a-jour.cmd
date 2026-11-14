@echo off
rem Met le logiciel a jour depuis GitHub. Ne touche ni a config.json ni au dossier donnees.
title Comptabilite Nowis - mise a jour
cd /d "%~dp0"
where git >nul 2>nul
if errorlevel 1 (
  echo Git n'est pas installe. Installez-le depuis https://git-scm.com/download/win puis relancez.
  start "" https://git-scm.com/download/win
  pause
  exit /b 1
)
if not exist .git (
  git init -q
  git remote add origin https://github.com/nowis30/comptabiliter-nowis.git
)
echo Recuperation de la derniere version...
git fetch -q origin main
if errorlevel 1 (
  echo Impossible de joindre GitHub. Verifiez Internet et votre connexion a GitHub.
  pause
  exit /b 1
)
git reset -q --hard origin/main
if errorlevel 1 (
  echo La mise a jour a echoue. Vos donnees n'ont pas ete touchees.
  pause
  exit /b 1
)
echo Mise a jour terminee. Fermez le serveur s'il tourne, puis relancez-le avec le raccourci.
pause
