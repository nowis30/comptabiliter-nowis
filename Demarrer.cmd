@echo off
title Comptabilite Nowis - serveur local (laisser ouvert)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js n'est pas installe sur cet ordinateur.
  echo Installez la version LTS depuis https://nodejs.org puis relancez.
  start "" https://nodejs.org/fr
  pause
  exit /b 1
)
node serveur.js %*
if errorlevel 1 pause
