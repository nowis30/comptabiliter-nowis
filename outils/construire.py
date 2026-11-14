"""Construit public/index.html à partir de source/app.html et source/client.js.

À lancer après une modification du logiciel :  python outils/construire.py
Le résultat ne contient ni données ni clés.
"""
import os

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def lire(chemin):
    with open(os.path.join(RACINE, chemin), encoding='utf-8') as f:
        return f.read()


src = lire('source/app.html')


def remplacer(ancien, nouveau):
    global src
    if src.count(ancien) != 1:
        raise SystemExit(f'Texte introuvable ou en double dans source/app.html : {ancien[:70]}')
    src = src.replace(ancien, nouveau)


# Hors ligne : pas de police distante, pdf.js servi par le serveur local.
i = src.index('<link rel="stylesheet" href="https://fonts.googleapis.com')
src = src[:i] + src[src.index('>', i) + 1:]
remplacer('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/', '/vendor/pdfjs/')
remplacer("Vos données sont enregistrées avec cette page, dans votre compte Claude. Elles restent privées tant que vous ne partagez pas la page. Le site NOWIS et le CRM ne sont pas modifiés par ce logiciel.",
          "Serveur local : vos données sont enregistrées sur cet ordinateur, dans le dossier « donnees » du logiciel, avec une copie de sécurité chaque jour. Le site NOWIS et le CRM ne sont pas modifiés par ce logiciel.")
remplacer("Les photos et l'analyse par Claude ne sont offertes que dans la version en ligne, ouverte avec votre compte Claude.",
          "La lecture automatique n'est pas activée : branchez l'agent NoWIS dans le fichier config.json du serveur (voir LISEZ-MOI). Vos photos et PDF sont tout de même joints et classés.")
remplacer("L'assistant n'est pas disponible dans cet affichage. En ligne, ouvrez la page avec votre compte Claude. Hors ligne, il faut brancher l'agent NoWIS dans les Réglages.",
          "L'assistant n'est pas encore branché : inscrivez la clé de l'agent NoWIS dans le fichier config.json du serveur, puis redémarrez-le (voir LISEZ-MOI).")

ti, tj = src.index('<title>'), src.index('</title>') + 8
titre, src = src[ti:tj], src[:ti] + src[tj:]
k = src.index('<script>\n"use strict";')
page = ('<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
        + titre + '<style>:root{color-scheme:light}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style></head><body>'
        + src[:k] + '<script>' + lire('source/client.js') + '</script>\n' + src[k:] + '</body></html>')
with open(os.path.join(RACINE, 'public', 'index.html'), 'w', encoding='utf-8') as f:
    f.write(page)
print(f'public/index.html construit ({len(page)} caractères).')
