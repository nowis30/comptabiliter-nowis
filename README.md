# Comptabilité Nowis

Logiciel de comptabilité de Création Nowis et des immeubles locatifs de Simon Morin, avec un petit serveur qui tourne sur l'ordinateur. Les données restent sur le disque, dans le dossier `donnees`; elles ne sont jamais envoyées dans ce dépôt.

Le mode d'emploi complet, pour l'utilisateur, est dans [LISEZ-MOI.txt](LISEZ-MOI.txt).

## Ce que fait le logiciel

- Ventes, factures, dépenses, loyers et immeubles avec parts de copropriété.
- TPS/TVQ, rapports, partie double, bilan, immobilisations et amortissement.
- Brouillons des formulaires FPZ-500, TP-80, T2125, TP-128 et T776.
- Import de relevés bancaires CSV et rapprochement bancaire.
- Factures récurrentes, rappels de paiement et envoi automatique de courriels (Resend).
- Verrouillage des périodes, clôture d'exercice et historique des modifications.
- Lecture des photos et PDF de factures par l'agent NoWIS.
- Synchronisation en lecture seule avec le CRM nowis.store et avec Saint-Lucien.

## Démarrer

Il faut Node.js 18 ou plus récent. Aucune dépendance à installer.

```bash
git clone https://github.com/nowis30/comptabiliter-nowis.git
```

```bash
cd comptabiliter-nowis
```

```bash
node serveur.js --ouvrir
```

Sous Windows : `Installer-le-raccourci.bat`, puis le raccourci du bureau. Mise à jour : `Mettre-a-jour.cmd`.

Au premier démarrage, `config.json` est créé à partir de `config.exemple.json`. Les clés s'y inscrivent; `config.json` et `donnees/` sont exclus du dépôt par `.gitignore`.

## Organisation du dépôt

| Chemin | Rôle |
|---|---|
| `serveur.js` | Serveur local (Node.js, sans dépendance) : données, fichiers, historique, synchronisation, courriels, agent NoWIS |
| `public/index.html` | Logiciel servi au navigateur, construit à partir de `source/` |
| `source/app.html` | Source du logiciel (aussi publiée comme version en ligne sur claude.ai) |
| `source/client.js` | Pont entre le logiciel et le serveur local |
| `outils/construire.py` | Reconstruit `public/index.html` après une modification de `source/` |
| `supabase/` | Fonction d'export en lecture seule et relais `compta-sync`, installés dans les projets Supabase |
| `*.cmd`, `*.bat` | Démarrage, raccourci, démarrage avec Windows, mise à jour |

Après une modification de `source/app.html` ou de `source/client.js` :

```bash
python outils/construire.py
```

## Synchronisation avec les CRM

Le serveur appelle le relais `compta-sync` de chaque projet Supabase avec une clé propre. La clé est vérifiée par son empreinte SHA-256 dans la table `compta_sync_clients`, et ne donne accès qu'aux données d'une organisation, en lecture seule.

- `supabase/compta_sync_crm.sql` : CRM nowis.store (commerce et immeubles).
- `supabase/compta_sync_immeubles.sql` : projet `nowis-immobilier` (immeubles seulement, Saint-Lucien).

### Ajouter une clé de synchronisation

1. Générer une clé aléatoire d'au moins 40 caractères (lettres, chiffres, `-`, `_`).
2. Dans le projet Supabase, inscrire son empreinte : `insert into public.compta_sync_clients (label, token_sha256, organization_id) values ('nom', encode(sha256('LA-CLE'::bytea), 'hex'), 'id-de-l-organisation');`
3. Mettre la clé dans `config.json` (`crm_cle`, ou une entrée de `crm_autres`).

Pour révoquer une clé : `update public.compta_sync_clients set enabled = false where label = 'nom';`

## Sécurité

- Le serveur écoute seulement sur l'ordinateur, sauf si `acces_reseau` est activé avec un code d'accès.
- Toute modification exige l'en-tête `X-Compta`, et l'adresse demandée est vérifiée : un autre site ouvert dans le navigateur ne peut pas modifier les données.
- Les périodes verrouillées sont protégées par le serveur lui-même.
- Ne publiez jamais `config.json` : il contient les clés de l'agent NoWIS, des CRM et de Resend.
