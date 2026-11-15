#!/usr/bin/env node
'use strict';
/*
 * Comptabilité Nowis — serveur local.
 * Aucune dépendance : il suffit de Node.js 18 ou plus récent.
 * Démarrage : node serveur.js            (ajoutez --ouvrir pour ouvrir le navigateur)
 * Les données sont dans le dossier « donnees » à côté de ce fichier.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFile } = require('node:child_process');

const VERSION = '1.5.0';
const RACINE = __dirname;
const PUBLIC = path.join(RACINE, 'public');
const DONNEES = path.join(RACINE, 'donnees');
const FICHIERS = path.join(DONNEES, 'fichiers');
const SAUVEGARDES = path.join(DONNEES, 'sauvegardes');
const BASE = path.join(DONNEES, 'compta.json');
const HISTORIQUE = path.join(DONNEES, 'historique.jsonl');
const CLOTURES = path.join(DONNEES, 'clotures');
const COLLECTIONS = ['ecritures', 'reglages', 'formulaires', 'contacts', 'documents', 'recurrences',
  'trajets', 'annexes', 'journal', 'comptes', 'immobilisations', 'rapprochements'];
const ID_DOC = /^[A-Za-z0-9_.~:@+-]{1,200}$/;
const ID_FICHIER = /^[0-9a-f]{32}$/;
const TYPES_FICHIERS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf' };
const MAX_JSON = 2 * 1024 * 1024;
const MAX_RESTAURATION = 50 * 1024 * 1024;
const MAX_FICHIER = 20 * 1024 * 1024;
const MAX_IA = 4 * 1024 * 1024;
const GARDER_SAUVEGARDES = 60;

/* ---------- Configuration ---------- */
function lireConfig() {
  let c = {};
  const fichier = path.join(RACINE, 'config.json'), exemple = path.join(RACINE, 'config.exemple.json');
  if (!fs.existsSync(fichier) && fs.existsSync(exemple)) {
    fs.copyFileSync(exemple, fichier);
    console.log('config.json créé à partir de config.exemple.json : inscrivez-y vos clés (voir LISEZ-MOI).');
  }
  try { c = JSON.parse(fs.readFileSync(fichier, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) {
    if (e.code !== 'ENOENT') { console.error(`Le fichier config.json est illisible : ${e.message}`); process.exit(1); }
  }
  const cfg = {
    port: Number.isInteger(+c.port) && +c.port > 1023 && +c.port < 65536 ? +c.port : 4810,
    reseau: c.acces_reseau === true,
    code: String(c.code_acces || ''),
    nowisUrl: String(c.nowis_file_url || '').trim(),
    nowisCle: String(c.nowis_cle || '').trim(),
    crmUrl: String(c.crm_url || '').trim(),
    crmCle: String(c.crm_cle || '').trim(),
    crmAutres: (Array.isArray(c.crm_autres) ? c.crm_autres : []).filter(x => x && typeof x === 'object')
      .map((x, i) => ({ id: String(x.id || `source${i + 2}`).replace(/[^a-z0-9-]/gi, '').slice(0, 30) || `source${i + 2}`, nom: String(x.nom || `Source ${i + 2}`).slice(0, 60), url: String(x.url || '').trim(), cle: String(x.cle || '').trim() })),
    crmMinutes: Number.isInteger(+c.crm_minutes) && +c.crm_minutes >= 2 ? +c.crm_minutes : 10,
    courrielCle: String(c.courriel_cle || '').trim(),
    courrielExpediteur: String(c.courriel_expediteur || '').trim(),
    courrielApi: String(c.courriel_api || 'https://api.resend.com').trim(),
    courrielRepondreA: String(c.courriel_repondre_a || '').trim(),
    copieExterne: c.copie_externe === undefined ? 'auto' : String(c.copie_externe || '').trim(),
  };
  if (cfg.reseau && cfg.code.length < 6) {
    console.error('Accès réseau demandé sans code d\'accès suffisant : inscrivez un "code_acces" d\'au moins 6 caractères dans config.json.');
    process.exit(1);
  }
  return cfg;
}
const cfg = lireConfig();

function urlPermise(texte) {
  try {
    const u = new URL(texte);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname));
  } catch { return false; }
}
function iaConfiguree() { return /^[A-Za-z0-9_-]{40,200}$/.test(cfg.nowisCle) && urlPermise(cfg.nowisUrl); }
function courrielConfigure() { return cfg.courrielCle.length >= 10 && /@/.test(cfg.courrielExpediteur) && urlPermise(cfg.courrielApi); }
/** Les sources lues : le CRM nowis.store, puis les autres (ex. Saint-Lucien). */
function sourcesCrm() {
  return [{ id: 'nowis', nom: 'CRM nowis.store', url: cfg.crmUrl, cle: cfg.crmCle }, ...cfg.crmAutres]
    .filter(x => /^[A-Za-z0-9_-]{40,200}$/.test(x.cle) && urlPermise(x.url));
}
function crmConfigure() { return sourcesCrm().length > 0; }

/* ---------- Stockage ---------- */
let D = {};

function attendre(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function ecrireAtomique(fichier, texte) {
  const tmp = `${fichier}.tmp`;
  fs.writeFileSync(tmp, texte);
  for (let essai = 0; ; essai++) {
    try { fs.renameSync(tmp, fichier); return; }
    catch (e) {
      // Windows : un antivirus ou l'indexation peut verrouiller le fichier un court instant.
      if (essai >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      attendre(60);
    }
  }
}

function normaliser(source) {
  const sortie = {};
  for (const c of COLLECTIONS) {
    const col = source && typeof source[c] === 'object' && source[c] && !Array.isArray(source[c]) ? source[c] : {};
    sortie[c] = {};
    for (const [id, doc] of Object.entries(col)) {
      if (ID_DOC.test(id) && doc && typeof doc === 'object' && !Array.isArray(doc)) sortie[c][id] = doc;
    }
  }
  return sortie;
}

function charger() {
  fs.mkdirSync(FICHIERS, { recursive: true });
  fs.mkdirSync(SAUVEGARDES, { recursive: true });
  fs.mkdirSync(CLOTURES, { recursive: true });
  if (fs.existsSync(BASE)) {
    try { D = normaliser(JSON.parse(fs.readFileSync(BASE, 'utf8').replace(/^\uFEFF/, ''))); }
    catch (e) {
      console.error(`\nLe fichier de données est endommagé : ${BASE}\n${e.message}\n`);
      console.error(`Pour le réparer, copiez la sauvegarde la plus récente du dossier\n  ${SAUVEGARDES}\nà la place de compta.json, puis relancez.`);
      process.exit(1);
    }
    return;
  }
  const initiales = path.join(RACINE, 'donnees-initiales.json');
  let source = {};
  if (fs.existsSync(initiales)) {
    try { source = JSON.parse(fs.readFileSync(initiales, 'utf8').replace(/^\uFEFF/, '')); }
    catch (e) { console.error(`donnees-initiales.json est illisible (${e.message}) : démarrage avec un logiciel vide.`); }
  }
  D = normaliser(source);
  ecrireAtomique(BASE, JSON.stringify(D));
  console.log(fs.existsSync(initiales) ? `Première utilisation : ${Object.keys(D.ecritures).length} écritures chargées depuis donnees-initiales.json.`
    : 'Première utilisation : le logiciel démarre vide. La synchronisation ramène les données du CRM; restaurez une sauvegarde pour le reste.');
}

function enregistrer() { ecrireAtomique(BASE, JSON.stringify(D)); }

function dateLocale() { return new Date().toLocaleDateString('sv-SE'); }

function sauvegardeDuJour() {
  try {
    const f = path.join(SAUVEGARDES, `compta-${dateLocale()}.json`);
    if (!fs.existsSync(f) && fs.existsSync(BASE)) fs.copyFileSync(BASE, f);
    const liste = fs.readdirSync(SAUVEGARDES).filter(x => /^compta-\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort();
    for (const x of liste.slice(0, -GARDER_SAUVEGARDES)) fs.unlinkSync(path.join(SAUVEGARDES, x));
  } catch (e) { console.error(`Sauvegarde quotidienne impossible : ${e.message}`); }
  copieExterne();
}

/* ---------- Copie hors de l'ordinateur (OneDrive, Google Drive) ---------- */
// Le serveur dépose ses copies dans un dossier synchronisé par OneDrive ou Google Drive pour ordinateur;
// c'est leur application qui les envoie dans le nuage. "auto" = OneDrive de Windows s'il est installé.
const etatCopie = { dossier: '', derniere: '', erreur: '' };
/** Le dossier de copie, et la racine qui doit déjà exister (le dossier OneDrive, ou le parent choisi). */
function dossierCopie() {
  const v = cfg.copieExterne;
  if (!v || v === 'non') return { dossier: '', racine: '' };
  if (v === 'auto') {
    const od = process.env.OneDrive || process.env.OneDriveConsumer || process.env.OneDriveCommercial || '';
    return od ? { dossier: path.join(od, 'Comptabilite Nowis', 'sauvegardes'), racine: od } : { dossier: '', racine: '' };
  }
  const d = path.resolve(v);
  return { dossier: d, racine: path.dirname(d) };
}
function copieExterne() {
  const { dossier, racine } = dossierCopie();
  etatCopie.dossier = dossier;
  if (!dossier) { etatCopie.erreur = ''; return; }
  try {
    if (!fs.existsSync(racine)) throw new Error(`le dossier ${racine} n'existe pas (OneDrive ou Google Drive est-il installé?)`);
    fs.mkdirSync(path.join(dossier, 'fichiers'), { recursive: true });
    // Copie du jour (remplacée à chaque passage par l'état le plus récent), historique et pièces jointes.
    ecrireAtomique(path.join(dossier, `compta-${dateLocale()}.json`), JSON.stringify({ app: 'compta-nowis', enregistre: new Date().toISOString(), ...D }));
    if (fs.existsSync(HISTORIQUE)) fs.copyFileSync(HISTORIQUE, path.join(dossier, 'historique.jsonl'));
    for (const f of fs.readdirSync(FICHIERS)) {
      const cible = path.join(dossier, 'fichiers', f);
      if (!fs.existsSync(cible)) fs.copyFileSync(path.join(FICHIERS, f), cible);
    }
    const liste = fs.readdirSync(dossier).filter(x => /^compta-\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort();
    for (const x of liste.slice(0, -GARDER_SAUVEGARDES)) fs.unlinkSync(path.join(dossier, x));
    Object.assign(etatCopie, { derniere: new Date().toISOString(), erreur: '' });
  } catch (e) {
    etatCopie.erreur = e.message;
    console.error(`Copie hors de l'ordinateur impossible : ${e.message}`);
  }
}

/** Applique un changement, l'écrit sur disque, et l'annule en mémoire si l'écriture échoue. */
function modifier(col, id, changement) {
  const avant = D[col][id];
  changement();
  try { enregistrer(); }
  catch (e) {
    if (avant === undefined) delete D[col][id]; else D[col][id] = avant;
    throw Object.assign(new Error(`Écriture sur le disque impossible : ${e.message}`), { statut: 500, code: 'disque' });
  }
}

/* ---------- Réglages, verrouillage des périodes ---------- */
const REGL_DEFAUT = { nom: 'Création Nowis', proprietaire: '', adresse: '', telephone: '', courriel: '', noTPS: '', noTVQ: '', dateInscription: '',
  tauxTPS: 5, tauxTVQ: 9.975, interacCourriel: '', interacNote: '', paypalMe: '', lienCarte: '', verrou: '',
  rappelsAuto: false, rappelsDelai: 3, rappelsIntervalle: 14, rappelsMax: 3, copieCourriel: '', prefixeFacture: 'CN-' };
const R = () => ({ ...REGL_DEFAUT, ...(D.reglages.entreprise || {}) });
const LIBRES = ['paiements', 'statut', 'aVerifier', 'note', 'pieces', 'maj', 'crm', 'docId', 'rappels', 'envois', 'pasDeRappel'];
const COLS_DATEES = ['ecritures', 'journal', 'trajets'];
const dateFrL = d => new Date(`${d}T12:00:00`).toLocaleDateString('fr-CA', { day: 'numeric', month: 'long', year: 'numeric' });
const enVerrou = d => { const v = R().verrou; return !!(v && d && String(d).slice(0, 10) <= v); };

/** Retourne un message si le changement touche une période verrouillée, sinon une chaîne vide. */
function refusVerrou(col, avant, apres) {
  const v = R().verrou;
  if (!v || !COLS_DATEES.includes(col) || !(enVerrou(avant && avant.date) || enVerrou(apres && apres.date))) return '';
  const m = `Période verrouillée jusqu'au ${dateFrL(v)} : `;
  if (!avant) return m + 'impossible d\'ajouter une écriture datée de cette période.';
  if (!apres) return m + 'impossible de supprimer cette écriture.';
  if (col !== 'ecritures') return m + 'cette écriture ne peut plus être modifiée.';
  const prot = o => JSON.stringify(Object.keys(o).filter(k => !LIBRES.includes(k) && k !== 'id' && o[k] !== undefined && o[k] !== null && o[k] !== '').sort().map(k => [k, o[k]]));
  if (prot(avant) !== prot(apres)) return m + 'seuls les paiements reçus après cette date, les notes et les pièces jointes peuvent changer.';
  const anc = l => JSON.stringify((l || []).filter(x => x.date && x.date <= v).map(x => JSON.stringify(x)).sort());
  return anc(avant.paiements) !== anc(apres.paiements) ? m + 'les paiements datés de cette période ne peuvent pas changer.' : '';
}
function exigerHorsVerrou(col, avant, apres) {
  const m = refusVerrou(col, avant, apres);
  if (m) throw Object.assign(new Error(m), { statut: 423, code: 'periode_verrouillee' });
}

/* ---------- Historique des modifications (ajout seulement) ---------- */
const TYPES_E = { facture: 'Facture', vente: 'Vente', depense: 'Dépense', loyer: 'Loyer' };
const argent = c => `${((c || 0) / 100).toFixed(2).replace('.', ',')} $`;
function resume(col, d) {
  if (!d) return '';
  if (col === 'ecritures') return [`${TYPES_E[d.type] || 'Écriture'}${d.numero ? ' ' + d.numero : ''}`, d.tiers, d.date, argent(d.total)].filter(Boolean).join(' · ');
  if (col === 'reglages') return 'Réglages de l\'entreprise';
  if (col === 'contacts') return d.nom || '';
  if (col === 'journal') return `${d.date || ''} · ${d.libelle || 'Écriture de journal'}`;
  if (col === 'recurrences') return d.nom || '';
  if (col === 'rapprochements') return `${d.compte || ''} · relevé du ${d.dateReleve || ''}`;
  if (col === 'immobilisations') return `${d.nom || ''} · ${argent(d.cout)}`;
  if (col === 'comptes') return `${d.numero || ''} · ${d.nom || ''}`;
  if (col === 'trajets') return `${d.date || ''} · ${d.a || ''} · ${d.km || 0} km`;
  return d.resume || d.nom || '';
}
function valeur(v) { const t = JSON.stringify(v); return t !== undefined && t.length > 4000 ? '…' : v; }
function difference(avant, apres) {
  const champs = {}, a = avant || {}, b = apres || {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) champs[k] = [valeur(a[k]), valeur(b[k])];
  }
  return champs;
}
function quiDe(req) { return !req ? 'Serveur' : estLocal(req) ? 'Ordinateur' : `Appareil ${String(req.socket.remoteAddress).replace('::ffff:', '')}`; }
function journaliser(qui, action, col, id, avant, apres, extra = {}) {
  let act = action;
  if (col === 'reglages' && action === 'modification' && (avant || {}).verrou !== (apres || {}).verrou) act = (apres || {}).verrou && (apres.verrou > ((avant || {}).verrou || '')) ? 'verrouillage' : 'deverrouillage';
  const ligne = { t: new Date().toISOString(), qui, action: act, col: col || '', id: id || '', resume: extra.resume || resume(col, apres || avant), champs: avant === null && apres === null ? {} : difference(avant, apres) };
  try { fs.appendFileSync(HISTORIQUE, JSON.stringify(ligne) + '\n'); }
  catch (e) { console.error(`Historique impossible à écrire : ${e.message}`); }
}
function lireHistorique({ col = '', id = '', limite = 300 }) {
  if (!fs.existsSync(HISTORIQUE)) return [];
  const lignes = fs.readFileSync(HISTORIQUE, 'utf8').split('\n'), sortie = [];
  for (let i = lignes.length - 1; i >= 0 && sortie.length < limite; i--) {
    if (!lignes[i]) continue;
    let h; try { h = JSON.parse(lignes[i]); } catch { continue; }
    if ((col && h.col !== col) || (id && h.id !== id)) continue;
    sortie.push(h);
  }
  return sortie;
}

/* ---------- Diffusion des changements (SSE) ---------- */
const flux = new Set();
function diffuser(col) {
  const message = `event: change\ndata: ${JSON.stringify({ col })}\n\n`;
  for (const r of flux) r.write(message);
}
setInterval(() => { for (const r of flux) r.write(': ping\n\n'); }, 25000).unref();

/* ---------- Agent NoWIS ---------- */
const CONSIGNE_AGENT = 'Tu réponds uniquement par un objet JSON valide, sans aucun texte avant ou après et sans bloc de code.';

function extraireJson(texte) {
  const t = String(texte || '').replace(/```(?:json)?/gi, '').trim();
  const debut = t.indexOf('{'), fin = t.lastIndexOf('}');
  if (debut < 0 || fin <= debut) return null;
  try { const o = JSON.parse(t.slice(debut, fin + 1)); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; }
  catch { return null; }
}

async function appelerAgent(prompt, images) {
  if (!iaConfiguree()) throw Object.assign(new Error('Agent NoWIS non configuré'), { statut: 501, code: 'ia_non_configuree' });
  const base = `${new URL(cfg.nowisUrl).origin}/functions/v1/nowis-local-queue/`;
  const entetes = { Authorization: `Bearer ${cfg.nowisCle}`, 'Content-Type': 'application/json' };
  const limite = Date.now() + 180000;
  const appel = (chemin, init = {}) => fetch(base + chemin, { ...init, headers: entetes, redirect: 'error', signal: AbortSignal.timeout(15000) });
  const horsLigne = () => Object.assign(new Error('L\'agent NoWIS ne répond pas'), { statut: 503, code: 'agent_hors_ligne' });

  let r;
  try { r = await appel('nowis_worker_status'); } catch { throw horsLigne(); }
  if (!r.ok) throw horsLigne();
  const etat = await r.json().catch(() => null);
  const vu = Date.parse(Array.isArray(etat) ? String(etat[0]?.last_seen || '') : '');
  if (!Number.isFinite(vu) || Date.now() - vu > 30000) throw horsLigne();

  const id = crypto.randomUUID();
  let soumis = false;
  try {
    r = await appel('nowis_jobs', { method: 'POST', body: JSON.stringify({
      id, instructions: CONSIGNE_AGENT, input: prompt, images, schema_name: 'compta_nowis', schema: {},
      options: { format: 'text', max_tokens: 3000 }, deadline: new Date(limite).toISOString(),
    }) });
    soumis = true;
    if (!r.ok) throw Object.assign(new Error(`File refusée (${r.status})`), { statut: 502, code: 'agent_echec' });
    while (Date.now() < limite) {
      await new Promise(ok => setTimeout(ok, 1500));
      r = await appel(`nowis_jobs?id=eq.${id}`);
      if (!r.ok) throw Object.assign(new Error(`File indisponible (${r.status})`), { statut: 502, code: 'agent_echec' });
      const lignes = await r.json().catch(() => null);
      const job = Array.isArray(lignes) ? lignes[0] : null;
      if (job?.status === 'failed') throw Object.assign(new Error('L\'agent NoWIS a échoué'), { statut: 502, code: 'agent_echec' });
      if (job?.status !== 'done') continue;
      const res = job.result || {};
      const objet = res.json && typeof res.json === 'object' && !Array.isArray(res.json) ? res.json : extraireJson(res.text);
      if (!objet) throw Object.assign(new Error('Réponse de l\'agent illisible'), { statut: 502, code: 'reponse_illisible' });
      return objet;
    }
    throw Object.assign(new Error('L\'agent NoWIS a pris trop de temps'), { statut: 504, code: 'agent_delai' });
  } finally {
    if (soumis) appel(`nowis_jobs?id=eq.${id}`, { method: 'DELETE' }).catch(() => undefined);
  }
}

/* ---------- Synchronisation avec le CRM nowis.store ---------- */
// Le CRM reste la source des factures, paiements et loyers. Une écriture corrigée ici après la
// dernière synchronisation n'est jamais écrasée : elle est signalée dans « À vérifier ».
const etatSync = { active: false, enCours: false, derniere: '', resultat: null, erreur: '' };
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const MODES = { transfer: 'Virement Interac', interac: 'Virement Interac', etransfer: 'Virement Interac', cash: 'Comptant', debit: 'Débit',
  credit: 'Crédit', card: 'Crédit', credit_card: 'Crédit', paypal: 'PayPal', cheque: 'Chèque', check: 'Chèque', other: 'Autre' };
const CATS_IMM = { school_taxes: 'Taxes scolaires', municipal_taxes: 'Taxes municipales', property_taxes: 'Taxes municipales', insurance: 'Assurances',
  mortgage_interest: 'Intérêts hypothécaires', interest: 'Intérêts hypothécaires', maintenance: 'Entretien et réparations', repairs: 'Entretien et réparations',
  utilities: 'Services publics', electricity: 'Services publics', heating: 'Services publics', management: 'Frais de gestion', management_fees: 'Frais de gestion' };
const ALIAS_IMMEUBLES = { 'maison blanche': 'Maison blanche', 'sur joel': 'Rue Joel', 'st lucien': 'Saint-Lucien', 'saint-lucien': 'Saint-Lucien' };
const cle8 = id => String(id || '').replace(/-/g, '').slice(0, 8);
const mode = m => MODES[String(m || '').toLowerCase()] || 'Autre';
const jour = d => String(d || '').slice(0, 10);
function nomImmeuble(n) {
  const k = String(n || '').trim().toLowerCase();
  if (ALIAS_IMMEUBLES[k]) return ALIAS_IMMEUBLES[k];
  const deja = Object.values(D.ecritures).find(e => e.immeuble && e.immeuble.toLowerCase() === k);
  return deja ? deja.immeuble : k.charAt(0).toUpperCase() + k.slice(1);
}
function statutDe(statutCrm, total, paye) {
  const s = String(statutCrm || '').toLowerCase();
  if (/cancel|void|annul/.test(s)) return 'annulee';
  if (/draft|brouillon/.test(s)) return 'ecartee';
  return paye <= 0 ? 'impayee' : paye >= total ? 'payee' : 'partielle';
}
const somme = l => l.reduce((t, p) => t + (p.montant || 0), 0);

function ecrituresDuCrm(x) {
  const proprio = String((D.reglages.entreprise || {}).proprietaire || 'Simon Morin').toLowerCase();
  const part = n => { const p = (x.parts || []).find(o => String(o.immeuble).toLowerCase() === String(n).toLowerCase() && String(o.proprietaire).toLowerCase() === proprio); return p ? p.part / 100 : 100; };
  const sortie = {};
  const source = 'CRM nowis.store (synchronisé)';
  for (const f of x.factures || []) {
    const paiements = (x.paiements || []).filter(p => p.facture === f.id && !p.annule).map(p => ({ date: jour(p.date), montant: p.montant, mode: mode(p.mode), ref: p.reference || '' }));
    let tps = 0, tvq = 0;
    if (f.taxes > 0) { tps = Math.round(f.sous_total * 0.05); tvq = f.taxes - tps; if (tvq < 0) { tps = f.taxes; tvq = 0; } }
    sortie[`new-${cle8(f.id)}`] = { crmId: f.id, type: 'facture', activite: 'nowis', source, numero: f.numero || '', date: jour(f.emise || f.maj), echeance: jour(f.echeance),
      tiers: f.client || '', courriel: f.courriel || '', description: f.titre || '', categorie: /gestion/i.test(f.titre || '') ? 'Gestion immobilière' : 'Autre revenu',
      sousTotal: f.sous_total || 0, tps, tvq, total: f.total || 0, statut: statutDe(f.statut, f.total, somme(paiements)), paiements, immeuble: '', part: 100 };
  }
  for (const d of x.dettes || []) {
    const paiements = (x.paiements || []).filter(p => p.dette === d.id && !p.annule).map(p => ({ date: jour(p.date), montant: p.montant, mode: mode(p.mode), ref: p.reference || '' }));
    sortie[`dep-${cle8(d.id)}`] = { crmId: d.id, type: 'depense', activite: 'nowis', source, numero: d.reference || '', date: jour(d.creee), echeance: jour(d.echeance),
      tiers: d.fournisseur || '', courriel: '', description: d.titre || '', categorie: 'Autre dépense', sousTotal: d.montant || 0, tps: 0, tvq: 0, total: d.montant || 0,
      statut: statutDe(d.statut, d.montant, somme(paiements)), paiements, immeuble: '', part: 100, aVerifierNouveau: 'Venue du CRM : précisez la catégorie et la TPS/TVQ payées.' };
  }
  for (const i of x.factures_immeubles || []) {
    const paiements = (x.paiements_immeubles || []).filter(p => p.facture === i.id && !/cancel|annul/.test(String(p.statut))).map(p => ({ date: jour(p.date), montant: p.montant, mode: mode(p.mode), ref: p.reference || '' }));
    const imm = nomImmeuble(i.immeuble), cat = CATS_IMM[i.categorie] || (/scolaire/i.test(i.fournisseur || '') ? 'Taxes scolaires' : /municipal/i.test(i.fournisseur || '') ? 'Taxes municipales' : "Autre dépense d'immeuble");
    sortie[`imm-${cle8(i.id)}`] = { crmId: i.id, type: 'depense', activite: 'immeuble', source, numero: i.reference || '', date: jour(i.emise), echeance: jour(i.echeance),
      tiers: String(i.fournisseur || '').replace(/\s+/g, ' ').trim(), courriel: '', description: cat, categorie: cat, sousTotal: i.total || 0, tps: 0, tvq: 0, total: i.total || 0,
      statut: statutDe(i.statut, i.total, somme(paiements)), paiements, immeuble: imm, part: part(i.immeuble) };
  }
  for (const l of x.loyers || []) {
    const periode = Array.isArray(l.periodes) && l.periodes.length === 1 ? jour(l.periodes[0]) : '';
    const recu = jour(l.date), retard = periode && (Date.parse(recu) - Date.parse(periode)) / 864e5 > 45;
    const date = retard ? periode : recu, m = periode ? `Loyer de ${MOIS[+periode.slice(5, 7) - 1]} ${periode.slice(0, 4)}` : 'Paiement de loyer';
    const annule = /cancel|annul|void/.test(String(l.statut || ''));
    sortie[`loy-${cle8(l.id)}`] = { crmId: l.id, type: 'loyer', activite: 'immeuble', source, numero: l.reference || '', date, echeance: '', tiers: `Logement ${l.logement || ''}`.trim(),
      courriel: '', description: m, categorie: 'Loyer', sousTotal: l.montant || 0, tps: 0, tvq: 0, total: l.montant || 0, statut: annule ? 'annulee' : 'payee',
      paiements: annule ? [] : [{ date: recu, montant: l.montant || 0, mode: mode(l.mode), ref: l.reference || '' }], immeuble: nomImmeuble(l.immeuble), part: part(l.immeuble) };
  }
  return sortie;
}
const CHAMPS_CRM = ['type', 'activite', 'numero', 'date', 'echeance', 'tiers', 'courriel', 'description', 'sousTotal', 'tps', 'tvq', 'total', 'statut', 'paiements', 'immeuble', 'part'];
const empreinte = e => crypto.createHash('sha256').update(JSON.stringify(CHAMPS_CRM.map(k => e[k]))).digest('hex').slice(0, 20);
const fmt = c => `${((c || 0) / 100).toFixed(2).replace('.', ',')} $`;
const STATUTS = { payee: 'payée', impayee: 'à recevoir ou à payer', partielle: 'partiellement payée', annulee: 'annulée', ecartee: 'brouillon' };

function fusionner(x, source = 'nowis') {
  const maintenant = new Date().toISOString(), crm = ecrituresDuCrm(x);
  const r = { nouvelles: 0, misesAJour: 0, aVerifier: 0, contacts: 0, inchangees: 0 };
  const changements = [], noter = (id, action, avant) => changements.push({ col: 'ecritures', id, action, avant });
  for (const [id, e] of Object.entries(crm)) {
    const fp = empreinte(e), loc = D.ecritures[id];
    const { crmId, aVerifierNouveau, ...champs } = e;
    if (!loc) {
      const verrou = enVerrou(champs.date) && !['annulee', 'ecartee'].includes(champs.statut);
      D.ecritures[id] = { ...champs, ...(verrou ? { statut: 'ecartee' } : {}),
        aVerifier: verrou ? 'Nouvelle dans le CRM, mais datée d\'une période verrouillée : elle est écartée de vos chiffres. Déverrouillez la période pour l\'intégrer.' : aVerifierNouveau || '',
        note: '', crm: { id: crmId, fp, sync: maintenant, source } };
      noter(id, 'creation', null);
      r.nouvelles++;
    } else if (!loc.crm) {
      // Écriture déjà saisie avant la synchronisation : on la relie au CRM sans toucher à ce qui a été corrigé ici.
      const pareil = loc.total === e.total && loc.statut === e.statut && somme(loc.paiements || []) === somme(e.paiements);
      noter(id, 'modification', JSON.parse(JSON.stringify(loc)));
      loc.crm = { id: crmId, fp, sync: maintenant, source };
      if (pareil) r.inchangees++;
      else { loc.aVerifier = `Le CRM indique ${fmt(e.total)}, ${STATUTS[e.statut] || e.statut}, ${fmt(somme(e.paiements))} reçu ou payé. Comparez avec cette écriture.`; r.aVerifier++; }
    } else if (loc.crm.fp !== fp) {
      noter(id, 'modification', JSON.parse(JSON.stringify(loc)));
      const corrigeeIci = loc.maj && loc.maj > loc.crm.sync;
      const candidat = { ...loc }; for (const k of CHAMPS_CRM) candidat[k] = champs[k];
      const verrouille = refusVerrou('ecritures', loc, candidat);
      if (verrouille) {
        loc.aVerifier = `Le CRM a modifié cette écriture d'une période verrouillée (il indique ${fmt(e.total)}, ${STATUTS[e.statut] || e.statut}) : rien n'a été changé ici.`;
        r.aVerifier++;
      } else if (corrigeeIci) {
        loc.aVerifier = `Modifiée dans le CRM depuis votre correction : le CRM indique ${fmt(e.total)}, ${STATUTS[e.statut] || e.statut}. Comparez et ajustez.`;
        r.aVerifier++;
      } else {
        for (const k of CHAMPS_CRM) loc[k] = champs[k];
        r.misesAJour++;
      }
      loc.crm = { ...loc.crm, fp, sync: maintenant, absent: false };
    } else r.inchangees++;
  }
  const vus = new Set(Object.values(crm).map(e => e.crmId));
  for (const loc of Object.values(D.ecritures)) {
    if (loc.crm && (loc.crm.source || 'nowis') === source && !vus.has(loc.crm.id) && !loc.crm.absent && !['annulee', 'ecartee'].includes(loc.statut)) {
      const idl = Object.keys(D.ecritures).find(k => D.ecritures[k] === loc);
      noter(idl, 'modification', JSON.parse(JSON.stringify(loc)));
      loc.crm.absent = true; loc.aVerifier = "Cette écriture n'existe plus dans le CRM : vérifiez si elle doit être annulée."; r.aVerifier++;
    }
  }
  const connus = Object.values(D.contacts);
  for (const c of x.clients || []) {
    const nom = String(c.nom || '').trim(), courriel = String(c.courriel || '').trim().toLowerCase();
    if (!nom || connus.some(k => String(k.nom || '').toLowerCase() === nom.toLowerCase() || (courriel && String(k.courriel || '').toLowerCase() === courriel))) continue;
    const a = c.adresse && typeof c.adresse === 'object' ? [c.adresse.line1, c.adresse.line2, c.adresse.city, c.adresse.region, c.adresse.postal_code].filter(Boolean).join(', ') : '';
    const id = `crm-cli-${cle8(c.id)}`;
    D.contacts[id] = { nom, personne: c.entreprise && c.entreprise !== nom ? c.entreprise : '', type: 'client', courriel: c.courriel || '', telephone: c.telephone || '', adresse: a, noTaxes: '', note: 'Ajouté depuis le CRM.' };
    changements.push({ col: 'contacts', id, action: 'creation', avant: null });
    connus.push(D.contacts[id]); r.contacts++;
  }
  r.changements = changements;
  return r;
}

async function lireSource(src) {
  let r;
  try { r = await fetch(`${new URL(src.url).origin}/functions/v1/compta-sync`, { headers: { Authorization: `Bearer ${src.cle}` }, redirect: 'error', signal: AbortSignal.timeout(30000) }); }
  catch { throw new Error('injoignable (connexion Internet?)'); }
  if (r.status === 401) throw new Error('clé refusée : vérifiez la clé dans config.json');
  if (!r.ok) throw new Error(`ne répond pas (${r.status})`);
  const x = await r.json().catch(() => null);
  if (!x || !Array.isArray(x.factures) || !Array.isArray(x.loyers)) throw new Error('réponse incomplète');
  return x;
}
async function synchroniser() {
  if (!crmConfigure() || etatSync.enCours) return etatSync;
  etatSync.enCours = true;
  const total = { nouvelles: 0, misesAJour: 0, aVerifier: 0, contacts: 0, inchangees: 0 }, erreurs = [], detail = [];
  try {
    for (const src of sourcesCrm()) {
      try {
        const x = await lireSource(src);
        const avant = JSON.stringify(D);
        const resultat = fusionner(x, src.id);
        const changements = resultat.changements; delete resultat.changements;
        if (JSON.stringify(D) !== avant) {
          try { enregistrer(); } catch (e) { D = JSON.parse(avant); throw new Error(`écriture sur le disque impossible : ${e.message}`); }
          for (const c of changements) {
            const apres = D[c.col][c.id];
            if (JSON.stringify(c.avant) !== JSON.stringify(apres)) journaliser(src.nom, 'synchronisation', c.col, c.id, c.avant, apres);
          }
          diffuser('ecritures'); diffuser('contacts');
        }
        for (const k of Object.keys(total)) total[k] += resultat[k] || 0;
        detail.push({ nom: src.nom, resultat });
        if (resultat.nouvelles || resultat.misesAJour || resultat.aVerifier || resultat.contacts) {
          console.log(`[${new Date().toLocaleTimeString('fr-CA')}] ${src.nom} : ${resultat.nouvelles} nouvelle(s), ${resultat.misesAJour} mise(s) à jour, ${resultat.aVerifier} à vérifier, ${resultat.contacts} contact(s).`);
        }
      } catch (e) {
        erreurs.push(`${src.nom} : ${e.message}`); detail.push({ nom: src.nom, erreur: e.message });
        console.error(`[${new Date().toLocaleTimeString('fr-CA')}] Synchronisation impossible — ${src.nom} : ${e.message}`);
      }
    }
    Object.assign(etatSync, { derniere: detail.some(d => d.resultat) ? new Date().toISOString() : etatSync.derniere, resultat: total, erreur: erreurs.join(' · '), sources: detail });
  } finally {
    etatSync.enCours = false;
    const m = `event: sync\ndata: ${JSON.stringify(etatSync)}\n\n`;
    for (const res of flux) res.write(m);
  }
  return etatSync;
}

/* ---------- Courriels : factures récurrentes et rappels ---------- */
const echap = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COURRIEL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function decaler(d, f, n = 1) {
  const x = new Date(`${d}T12:00:00`);
  if (f === 'hebdo') x.setDate(x.getDate() + 7 * n); else if (f === '2sem') x.setDate(x.getDate() + 14 * n);
  else x.setMonth(x.getMonth() + n * (f === 'mensuel' ? 1 : f === 'trimestriel' ? 3 : 12));
  return x.toISOString().slice(0, 10);
}
const montantTaxe = (s, t) => Math.round(s * Math.round(t * 1000) / 100000);
const paye = e => (e.paiements || []).reduce((t, x) => t + (x.montant || 0), 0);
const solde = e => e.statut === 'payee' ? 0 : Math.max(0, (e.total || 0) - paye(e));

async function envoyerCourriel({ a, objet, texte, html }) {
  if (!courrielConfigure()) throw Object.assign(new Error('Envoi de courriels non configuré'), { statut: 501, code: 'courriel_non_configure' });
  const copie = String(R().copieCourriel || '').trim();
  const r = await fetch(`${new URL(cfg.courrielApi).origin}/emails`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${cfg.courrielCle}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: cfg.courrielExpediteur, to: [a], subject: objet, text: texte, html,
      ...(COURRIEL.test(copie) && copie.toLowerCase() !== a.toLowerCase() ? { bcc: [copie] } : {}),
      ...(COURRIEL.test(cfg.courrielRepondreA) ? { reply_to: cfg.courrielRepondreA } : {}) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`le service de courriel a refusé l'envoi (${r.status}${j.message ? ' : ' + j.message : ''})`), { statut: 502, code: 'courriel_refuse' });
  return j.id || '';
}

function moyensPaiement(e) {
  const g = R(), l = [], s = solde(e) || e.total || 0;
  if (g.interacCourriel) l.push(`Virement Interac à ${g.interacCourriel}${g.interacNote ? ` (${g.interacNote})` : ''}${e.numero ? `. Inscrivez « ${e.numero} » dans le message` : ''}.`);
  if (g.paypalMe) l.push(`PayPal ou carte par PayPal : https://paypal.me/${encodeURIComponent(g.paypalMe.replace(/^.*paypal\.me\//i, '').replace(/^@/, '').trim())}/${(s / 100).toFixed(2)}CAD`);
  if (g.lienCarte) l.push(`Carte de crédit : ${g.lienCarte}`);
  return l;
}
function signature() { const g = R(); return [g.proprietaire, g.nom, [g.telephone, g.courriel].filter(Boolean).join(' · '), g.adresse].filter(Boolean); }
function courrielFacture(e) {
  const g = R(), m = moyensPaiement(e), lignes = [['Montant avant taxes', argent(e.sousTotal)], ...(e.tps || e.tvq ? [['TPS (' + String(g.tauxTPS).replace('.', ',') + ' %)', argent(e.tps)], ['TVQ (' + String(g.tauxTVQ).replace('.', ',') + ' %)', argent(e.tvq)]] : []), ['Total', argent(e.total)]];
  const objet = `Facture ${e.numero} — ${g.nom} — ${argent(e.total)}`;
  const texte = [`Bonjour,`, '', `Voici la facture ${e.numero} du ${dateFrL(e.date)}${e.echeance ? `, payable au plus tard le ${dateFrL(e.echeance)}` : ''}.`, '',
    `Client : ${e.tiers}`, `Description : ${e.description}`, ...lignes.map(([k, v]) => `${k} : ${v}`), '',
    ...(m.length ? ['Pour payer :', ...m.map(x => '• ' + x), ''] : []), 'Merci.', '', ...signature(),
    ...(g.noTPS || g.noTVQ ? [`TPS : ${g.noTPS} · TVQ : ${g.noTVQ}`] : [])].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1b241f;max-width:620px">
<h2 style="margin:0 0 4px">${echap(g.nom)}</h2><p style="margin:0;color:#5d6a62">${signature().slice(2).map(echap).join('<br>')}${g.noTPS || g.noTVQ ? `<br>TPS : ${echap(g.noTPS)} · TVQ : ${echap(g.noTVQ)}` : ''}</p>
<h3 style="margin:18px 0 6px">Facture ${echap(e.numero)}</h3><p style="margin:0">Date : ${echap(dateFrL(e.date))}${e.echeance ? `<br>Payable au plus tard le ${echap(dateFrL(e.echeance))}` : ''}<br>Client : ${echap(e.tiers)}</p>
<table style="border-collapse:collapse;margin:14px 0;width:100%"><tr><td style="padding:6px 0;border-bottom:1px solid #d9ded8">${echap(e.description)}</td><td></td></tr>${lignes.map(([k, v], i) => `<tr><td style="padding:6px 0;${i === lignes.length - 1 ? 'font-weight:bold;border-top:2px solid #1b241f' : ''}">${echap(k)}</td><td style="padding:6px 0;text-align:right;${i === lignes.length - 1 ? 'font-weight:bold;border-top:2px solid #1b241f' : ''}">${echap(v)}</td></tr>`).join('')}</table>
${m.length ? `<p style="margin:0 0 4px"><b>Pour payer :</b></p><ul style="margin:0;padding-left:20px">${m.map(x => `<li>${echap(x)}</li>`).join('')}</ul>` : ''}<p>Merci.</p></div>`;
  return { objet, texte, html };
}
function courrielRappel(e, n) {
  const g = R(), m = moyensPaiement(e), du = e.echeance || decaler(e.date, 'mensuel');
  const objet = `Rappel${n > 1 ? ' ' + n : ''} : facture ${e.numero || ''} — solde de ${argent(solde(e))}`.replace('  ', ' ');
  const corps = [`Bonjour,`, '', `Sauf erreur de ma part, la facture${e.numero ? ' ' + e.numero : ''} du ${dateFrL(e.date)}, au montant de ${argent(e.total)}, était payable le ${dateFrL(du)}. Il reste un solde de ${argent(solde(e))}.`, '',
    'Merci d\'effectuer le paiement dès que possible, ou de me répondre si vous avez des questions.', '', ...(m.length ? ['Pour payer :', ...m.map(x => '• ' + x), ''] : []), ...signature()];
  return { objet, texte: corps.join('\n'), html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1b241f;max-width:620px">${corps.map(l => l.startsWith('• ') ? `&nbsp;&nbsp;${echap(l)}<br>` : l ? `${echap(l)}<br>` : '<br>').join('')}</div>` };
}
function ecritureRecurrente(r, d) {
  const g = R(), deb = decaler(d, r.frequence, -1), x = new Date(`${d}T12:00:00`); x.setDate(x.getDate() - 1);
  const per = `du ${dateFrL(deb)} au ${dateFrL(x.toISOString().slice(0, 10))}`;
  const tx = r.taxes && r.activite !== 'immeuble' && g.dateInscription && d >= g.dateInscription, s = r.sousTotal || 0;
  const tps = tx ? montantTaxe(s, g.tauxTPS) : 0, tvq = tx ? montantTaxe(s, g.tauxTVQ) : 0, ech = new Date(`${d}T12:00:00`); ech.setDate(ech.getDate() + (+r.delai || 0));
  const desc = String(r.description || r.nom).includes('{periode}') ? r.description.replace('{periode}', per) : `${r.description || r.nom} — ${per}`;
  return { type: 'facture', activite: 'nowis', source: `Récurrente : ${r.nom}`, numero: '', date: d, echeance: ech.toISOString().slice(0, 10), tiers: r.tiers || '', courriel: r.courriel || '',
    description: desc, categorie: r.categorie || '', sousTotal: s, tps, tvq, total: s + tps + tvq, statut: 'impayee', paiements: [], immeuble: '', part: 100, aVerifier: '', note: '', maj: new Date().toISOString() };
}
function prochainNumero() {
  const g = R(), an = dateLocale().slice(0, 4), prefixe = String(g.prefixeFacture || 'CN-');
  const pris = Object.values(D.ecritures).map(e => String(e.numero || '')).filter(n => n.startsWith(`${prefixe}${an}-`)).map(n => +n.slice(`${prefixe}${an}-`.length) || 0);
  return `${prefixe}${an}-${String(Math.max(0, ...pris) + 1).padStart(3, '0')}`;
}
function envoisDus() {
  const g = R(), auj = dateLocale(), dus = [];
  for (const [rid, r] of Object.entries(D.recurrences)) {
    if (!r.actif || !r.envoiAuto || r.type !== 'facture' || !r.prochaine) continue;
    for (let d = r.prochaine, n = 0; d <= auj && n < 12 && !enVerrou(d); d = decaler(d, r.frequence), n++) {
      dus.push({ type: 'facture', modele: rid, date: d, a: r.courriel || '', objet: `Facture (${r.nom}) du ${dateFrL(d)}`, probleme: COURRIEL.test(r.courriel || '') ? '' : 'Courriel du client manquant : la facture sera créée mais non envoyée.' });
    }
  }
  if (g.rappelsAuto) {
    for (const [id, e] of Object.entries(D.ecritures)) {
      if (e.type !== 'facture' || ['annulee', 'ecartee'].includes(e.statut) || e.pasDeRappel || solde(e) <= 0) continue;
      // Le retard compte à partir de l'échéance, ou de l'envoi de la facture s'il est plus récent (facture émise en rattrapage).
      const du = [e.echeance || decaler(e.date, 'mensuel'), ...(e.envois || []).map(x => x.date)].sort().pop(), retard = (Date.parse(auj) - Date.parse(du)) / 864e5, envois = e.rappels || [];
      if (retard < (+g.rappelsDelai || 0) || envois.length >= (+g.rappelsMax || 3)) continue;
      const dernier = envois.length ? envois[envois.length - 1].date : '';
      if (dernier && (Date.parse(auj) - Date.parse(dernier)) / 864e5 < (+g.rappelsIntervalle || 14)) continue;
      dus.push({ type: 'rappel', ecriture: id, a: e.courriel || '', numeroRappel: envois.length + 1, objet: courrielRappel(e, envois.length + 1).objet,
        probleme: COURRIEL.test(e.courriel || '') ? '' : 'Courriel du client manquant : aucun rappel ne sera envoyé.' });
    }
  }
  return dus;
}
let envoisEnCours = false;
async function faireEnvois(qui) {
  if (envoisEnCours) return { envoyes: 0, erreurs: 0, message: 'Envoi déjà en cours.' };
  envoisEnCours = true;
  const res = { envoyes: 0, erreurs: 0, message: '' }, auj = dateLocale();
  try {
    for (const x of envoisDus()) {
      if (x.type === 'facture') {
        const r = D.recurrences[x.modele], id = `r-${x.modele}-${x.date}`;
        if (!D.ecritures[id]) {
          const e = { ...ecritureRecurrente(r, x.date), numero: prochainNumero() };
          D.ecritures[id] = e; enregistrer(); journaliser(qui, 'generation', 'ecritures', id, null, e);
          if (COURRIEL.test(e.courriel)) {
            const avant = JSON.parse(JSON.stringify(e));
            try { const c = courrielFacture(e); await envoyerCourriel({ a: e.courriel, ...c }); e.envois = [{ date: auj, a: e.courriel }]; res.envoyes++; }
            catch (err) { e.aVerifier = `Facture créée, mais l'envoi par courriel a échoué : ${err.message}. Envoyez-la à la main.`; res.erreurs++; res.message = err.message; }
            enregistrer(); journaliser(qui, 'envoi', 'ecritures', id, avant, e);
          } else { e.aVerifier = 'Facture créée automatiquement, mais le modèle n\'a pas de courriel de client : envoyez-la à la main.'; enregistrer(); }
        }
        const avantM = JSON.parse(JSON.stringify(r)); r.prochaine = decaler(x.date, r.frequence); enregistrer(); journaliser(qui, 'modification', 'recurrences', x.modele, avantM, r);
        diffuser('ecritures'); diffuser('recurrences');
      } else if (x.a && COURRIEL.test(x.a)) {
        const e = D.ecritures[x.ecriture], avant = JSON.parse(JSON.stringify(e));
        try { await envoyerCourriel({ a: x.a, ...courrielRappel(e, x.numeroRappel) }); e.rappels = [...(e.rappels || []), { date: auj, a: x.a }]; enregistrer(); journaliser(qui, 'envoi', 'ecritures', x.ecriture, avant, e); res.envoyes++; diffuser('ecritures'); }
        catch (err) { res.erreurs++; res.message = err.message; }
      }
    }
  } finally { envoisEnCours = false; }
  if (res.envoyes || res.erreurs) console.log(`[${new Date().toLocaleTimeString('fr-CA')}] Courriels : ${res.envoyes} envoyé(s), ${res.erreurs} erreur(s)${res.message ? ' — ' + res.message : ''}.`);
  return res;
}

/* ---------- Accès réseau et sécurité ---------- */
function adressesReseau() {
  const sortie = [];
  for (const liste of Object.values(os.networkInterfaces())) {
    for (const a of liste || []) if (a.family === 'IPv4' && !a.internal) sortie.push(a.address);
  }
  return sortie;
}
function hoteAutorise(req) {
  const h = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (['localhost', '127.0.0.1', '::1'].includes(h)) return true;
  if (!cfg.reseau) return false;
  const nom = os.hostname().toLowerCase();
  return adressesReseau().includes(h) || [nom, `${nom}.local`, `${nom}.lan`, `${nom}.home`].includes(h);
}
function estLocal(req) { return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress); }

const sessions = new Set();
const echecs = new Map();
function cookie(req, nom) {
  for (const morceau of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = morceau.trim().split('=');
    if (k === nom) return v.join('=');
  }
  return '';
}
function autorise(req) { return !cfg.reseau || estLocal(req) || sessions.has(cookie(req, 'compta_session')); }
function egal(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

const ENTETES = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};
const CSP_PAGE = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function repondre(res, statut, corps, entetes = {}) {
  const json = typeof corps !== 'string' && !Buffer.isBuffer(corps);
  res.writeHead(statut, { ...ENTETES, 'Cache-Control': 'no-store', ...(json ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...entetes });
  res.end(json ? JSON.stringify(corps) : corps);
}
function erreur(res, statut, code, message) { repondre(res, statut, { erreur: code, message }); }

function lireCorps(req, max) {
  return new Promise((ok, ko) => {
    const morceaux = []; let taille = 0, trop = false;
    req.on('data', m => {
      if (trop) return;
      taille += m.length;
      if (taille > max) { trop = true; morceaux.length = 0; return; }
      morceaux.push(m);
    });
    req.on('end', () => trop ? ko(Object.assign(new Error('Contenu trop volumineux'), { statut: 413, code: 'too_large' })) : ok(Buffer.concat(morceaux)));
    req.on('error', ko);
  });
}
async function lireJson(req, max = MAX_JSON) {
  const brut = await lireCorps(req, max);
  let o;
  try { o = JSON.parse(brut.toString('utf8')); } catch { throw Object.assign(new Error('JSON invalide'), { statut: 400, code: 'invalid_argument' }); }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw Object.assign(new Error('Objet JSON attendu'), { statut: 400, code: 'invalid_argument' });
  return o;
}

function signatureOk(type, b) {
  const debut = (s) => b.subarray(0, s.length).equals(Buffer.from(s, 'binary'));
  if (type === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === 'image/png') return debut('\x89PNG');
  if (type === 'image/gif') return debut('GIF8');
  if (type === 'image/webp') return debut('RIFF') && b.subarray(8, 12).toString('binary') === 'WEBP';
  if (type === 'application/pdf') return debut('%PDF');
  return false;
}
function trouverFichier(id) {
  for (const [type, ext] of Object.entries(TYPES_FICHIERS)) {
    const f = path.join(FICHIERS, id + ext);
    if (fs.existsSync(f)) return { f, type };
  }
  return null;
}

const PAGE_CONNEXION = (message = '') => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Comptabilité Nowis</title>
<style>:root{color-scheme:light dark}body{font:16px system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}form{display:flex;flex-direction:column;gap:12px;width:min(340px,100%)}input,button{font:inherit;padding:10px;border-radius:4px;border:1px solid #8a938d}button{background:#1f6b4a;color:#fff;border-color:#1f6b4a;font-weight:600}p{margin:0}.err{color:#a3312b}</style></head>
<body><form method="post" action="/connexion"><h1 style="margin:0;font-size:22px">Comptabilité Nowis</h1><p>Inscrivez le code d'accès choisi dans le fichier config.json de l'ordinateur.</p>${message ? `<p class="err">${message}</p>` : ''}<label>Code d'accès<br><input type="password" name="code" autocomplete="current-password" autofocus required></label><button>Entrer</button></form></body></html>`;

/* ---------- Routes ---------- */
async function traiter(req, res) {
  if (!hoteAutorise(req)) return erreur(res, 421, 'hote', 'Adresse non autorisée.');
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;

  if (p === '/connexion') {
    if (!cfg.reseau || estLocal(req)) return repondre(res, 303, '', { Location: '/' });
    if (req.method === 'GET') return repondre(res, 200, PAGE_CONNEXION(), { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" });
    if (req.method !== 'POST') return erreur(res, 405, 'methode', 'Méthode non permise.');
    const ip = req.socket.remoteAddress, e = echecs.get(ip) || { n: 0, jusqua: 0 };
    if (e.jusqua > Date.now()) return repondre(res, 429, PAGE_CONNEXION('Trop d\'essais. Réessayez dans 15 minutes.'), { 'Content-Type': 'text/html; charset=utf-8' });
    const code = new URLSearchParams((await lireCorps(req, 4096)).toString('utf8')).get('code') || '';
    if (!egal(code, cfg.code)) {
      e.n++; if (e.n >= 5) { e.n = 0; e.jusqua = Date.now() + 15 * 60000; } echecs.set(ip, e);
      return repondre(res, 401, PAGE_CONNEXION('Code incorrect.'), { 'Content-Type': 'text/html; charset=utf-8' });
    }
    echecs.delete(ip);
    const jeton = crypto.randomBytes(32).toString('hex');
    sessions.add(jeton);
    return repondre(res, 303, '', { Location: '/', 'Set-Cookie': `compta_session=${jeton}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
  }

  if (!autorise(req)) {
    if (p.startsWith('/api/') || p.startsWith('/_blob/')) return erreur(res, 401, 'not_granted', 'Connexion requise.');
    return repondre(res, 303, '', { Location: '/connexion' });
  }

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    return repondre(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html')), { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP_PAGE });
  }
  if (req.method === 'GET' && /^\/vendor\/pdfjs\/pdf(\.worker)?\.min\.js$/.test(p)) {
    return repondre(res, 200, fs.readFileSync(path.join(PUBLIC, p)), { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'max-age=86400' });
  }
  if (req.method === 'GET' && p.startsWith('/_blob/')) {
    const id = p.slice(7);
    const trouve = ID_FICHIER.test(id) && trouverFichier(id);
    if (!trouve) return erreur(res, 404, 'introuvable', 'Fichier introuvable.');
    return repondre(res, 200, fs.readFileSync(trouve.f), { 'Content-Type': trouve.type, 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'Content-Disposition': 'inline' });
  }

  if (!p.startsWith('/api/')) return erreur(res, 404, 'introuvable', 'Page introuvable.');
  // Toute modification exige cet en-tête : un autre site ouvert dans le navigateur ne peut pas l'envoyer.
  if (req.method !== 'GET' && req.headers['x-compta'] !== '1') return erreur(res, 403, 'origine', 'Requête refusée.');

  if (req.method === 'GET' && p === '/api/etat') {
    return repondre(res, 200, { version: VERSION, ia: iaConfiguree(), sync: etatSync, dossier: DONNEES, reseau: cfg.reseau,
      courriel: { configure: courrielConfigure(), expediteur: courrielConfigure() ? cfg.courrielExpediteur : '' }, copie: etatCopie,
      adresses: cfg.reseau ? adressesReseau().map(a => `http://${a}:${cfg.port}`) : [] });
  }
  if (req.method === 'GET' && p === '/api/donnees') return repondre(res, 200, D);
  if (req.method === 'GET' && p === '/api/evenements') {
    res.writeHead(200, { ...ENTETES, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': ouvert\n\n');
    flux.add(res);
    req.on('close', () => flux.delete(res));
    return;
  }
  if (req.method === 'GET' && p === '/api/sauvegarde') {
    return repondre(res, 200, JSON.stringify({ app: 'compta-nowis', enregistre: new Date().toISOString(), ...D }, null, 1), {
      'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="sauvegarde-nowis-${dateLocale()}.json"` });
  }
  if (req.method === 'POST' && p === '/api/restaurer') {
    const source = await lireJson(req, MAX_RESTAURATION);
    if (!source.ecritures || typeof source.ecritures !== 'object') return erreur(res, 400, 'invalid_argument', 'Ce fichier n\'est pas une sauvegarde de Comptabilité Nowis.');
    const copie = path.join(SAUVEGARDES, `compta-avant-restauration-${Date.now()}.json`);
    fs.copyFileSync(BASE, copie);
    const avant = D;
    D = normaliser(source);
    try { enregistrer(); } catch (e) { D = avant; throw Object.assign(e, { statut: 500, code: 'disque' }); }
    journaliser(quiDe(req), 'restauration', '', '', null, null, { resume: `Sauvegarde restaurée : ${Object.keys(D.ecritures).length} écritures (copie de l'état précédent : ${path.basename(copie)})` });
    COLLECTIONS.forEach(diffuser);
    return repondre(res, 200, { ok: true, ecritures: Object.keys(D.ecritures).length, copie_precedente: path.basename(copie) });
  }
  if (req.method === 'GET' && p === '/api/historique') {
    const limite = Math.min(1000, Math.max(1, +url.searchParams.get('limite') || 300));
    return repondre(res, 200, lireHistorique({ col: url.searchParams.get('col') || '', id: url.searchParams.get('id') || '', limite }));
  }
  if (req.method === 'GET' && p === '/api/clotures') {
    const l = fs.readdirSync(CLOTURES).filter(f => /^exercice-\d{4}-.*\.json$/.test(f)).sort().map(f => ({ annee: f.slice(9, 13), fichier: f, le: fs.statSync(path.join(CLOTURES, f)).mtime.toISOString() }));
    return repondre(res, 200, l);
  }
  if (req.method === 'POST' && p === '/api/cloturer') {
    const { annee } = await lireJson(req);
    if (!/^\d{4}$/.test(String(annee))) return erreur(res, 400, 'invalid_argument', 'Année invalide.');
    if (dateLocale() <= `${annee}-12-31`) return erreur(res, 400, 'exercice_en_cours', `Vous pourrez clôturer ${annee} à partir du 1er janvier ${+annee + 1}.`);
    const avant = D.reglages.entreprise ? { ...D.reglages.entreprise } : {};
    const fin = `${annee}-12-31`, verrou = (avant.verrou || '') > fin ? avant.verrou : fin;
    modifier('reglages', 'entreprise', () => { D.reglages.entreprise = { ...REGL_DEFAUT, ...avant, verrou }; });
    const fichier = `exercice-${annee}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
    fs.writeFileSync(path.join(CLOTURES, fichier), JSON.stringify({ app: 'compta-nowis', cloture: { annee: String(annee), le: new Date().toISOString() }, ...D }, null, 1));
    journaliser(quiDe(req), 'cloture', 'reglages', 'entreprise', avant, D.reglages.entreprise, { resume: `Exercice ${annee} clôturé · copie figée ${fichier}` });
    diffuser('reglages');
    return repondre(res, 200, { ok: true, verrou, fichier });
  }
  if (req.method === 'POST' && p === '/api/courriel/essai') {
    const { a } = await lireJson(req);
    if (!COURRIEL.test(String(a || ''))) return erreur(res, 400, 'invalid_argument', 'Adresse de courriel invalide.');
    const g = R();
    await envoyerCourriel({ a, objet: `Essai — ${g.nom}`, texte: 'Ce courriel confirme que Comptabilité Nowis peut envoyer vos factures et vos rappels.', html: '<p>Ce courriel confirme que <b>Comptabilité Nowis</b> peut envoyer vos factures et vos rappels.</p>' });
    journaliser(quiDe(req), 'envoi', '', '', null, null, { resume: `Courriel d'essai envoyé à ${a}` });
    return repondre(res, 200, { ok: true });
  }
  if (req.method === 'GET' && p === '/api/envois/prevus') return repondre(res, 200, envoisDus());
  if (req.method === 'POST' && p === '/api/envois/executer') {
    if (!courrielConfigure()) return erreur(res, 501, 'courriel_non_configure', 'L\'envoi de courriels n\'est pas configuré dans config.json.');
    return repondre(res, 200, await faireEnvois(quiDe(req)));
  }
  if (req.method === 'POST' && p === '/api/synchroniser') {
    if (!crmConfigure()) return erreur(res, 501, 'crm_non_configure', 'La synchronisation avec le CRM n\'est pas configurée.');
    return repondre(res, 200, await synchroniser());
  }
  if (req.method === 'POST' && p === '/api/fichiers') {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!TYPES_FICHIERS[type]) return erreur(res, 415, 'unsupported_type', 'Type de fichier non accepté.');
    const corps = await lireCorps(req, MAX_FICHIER);
    if (!corps.length || !signatureOk(type, corps)) return erreur(res, 415, 'unsupported_type', 'Le contenu ne correspond pas au type annoncé.');
    const id = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(FICHIERS, id + TYPES_FICHIERS[type]), corps);
    return repondre(res, 201, { id, url: `/_blob/${id}`, sizeBytes: corps.length, contentType: type });
  }
  if (req.method === 'POST' && p === '/api/ia') {
    const o = await lireJson(req, MAX_IA);
    const prompt = typeof o.prompt === 'string' ? o.prompt : '';
    const images = Array.isArray(o.images) ? o.images : [];
    if (!prompt || prompt.length > 60000) return erreur(res, 400, 'invalid_argument', 'Demande vide ou trop longue.');
    if (images.length > 3 || images.some(i => typeof i !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(i))) {
      return erreur(res, 400, 'image_rejected', 'Images non acceptées : jusqu\'à trois images JPEG, PNG ou WebP.');
    }
    return repondre(res, 200, await appelerAgent(prompt, images));
  }

  const m = p.match(/^\/api\/c\/([a-z]+)(?:\/([^/]+))?$/);
  if (m && COLLECTIONS.includes(m[1])) {
    const col = m[1];
    if (!m[2]) {
      if (req.method === 'GET') return repondre(res, 200, D[col]);
      return erreur(res, 405, 'methode', 'Méthode non permise.');
    }
    const id = decodeURIComponent(m[2]);
    if (!ID_DOC.test(id)) return erreur(res, 400, 'invalid_argument', 'Identifiant invalide.');
    if (req.method === 'GET') return D[col][id] ? repondre(res, 200, D[col][id]) : erreur(res, 404, 'introuvable', 'Document introuvable.');
    if (req.method === 'PUT') {
      const doc = await lireJson(req), avant = D[col][id];
      exigerHorsVerrou(col, avant, doc);
      modifier(col, id, () => { D[col][id] = doc; });
      journaliser(quiDe(req), avant ? 'modification' : 'creation', col, id, avant || null, doc);
      diffuser(col);
      return repondre(res, 200, { ok: true });
    }
    if (req.method === 'PATCH') {
      const champs = await lireJson(req);
      if (!D[col][id]) return erreur(res, 404, 'invalid_argument', 'Document introuvable.');
      const avant = D[col][id], apres = { ...avant, ...champs };
      exigerHorsVerrou(col, avant, apres);
      modifier(col, id, () => { D[col][id] = apres; });
      journaliser(quiDe(req), 'modification', col, id, avant, apres);
      diffuser(col);
      return repondre(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') {
      const avant = D[col][id];
      if (avant) {
        exigerHorsVerrou(col, avant, null);
        modifier(col, id, () => { delete D[col][id]; });
        journaliser(quiDe(req), 'suppression', col, id, avant, null);
        diffuser(col);
      }
      return repondre(res, 204, '');
    }
    return erreur(res, 405, 'methode', 'Méthode non permise.');
  }
  return erreur(res, 404, 'introuvable', 'Adresse inconnue.');
}

/* ---------- Démarrage ---------- */
function ouvrirNavigateur(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  execFile(cmd, args, () => undefined);
}

charger();
sauvegardeDuJour();
setInterval(sauvegardeDuJour, 3 * 3600 * 1000).unref();
process.on('SIGINT', () => { copieExterne(); process.exit(0); });
process.on('SIGTERM', () => { copieExterne(); process.exit(0); });
// Windows : fermer la fenêtre du serveur envoie SIGHUP; on en profite pour faire une dernière copie.
process.on('SIGHUP', () => { copieExterne(); process.exit(0); });

const serveur = http.createServer((req, res) => {
  traiter(req, res).catch(e => {
    if (res.headersSent) { res.end(); return; }
    if (!e.statut || e.statut >= 500) console.error(`[${new Date().toLocaleTimeString('fr-CA')}] ${req.method} ${req.url} : ${e.message}`);
    erreur(res, e.statut || 500, e.code || 'unavailable', e.statut ? e.message : 'Erreur du serveur.');
  });
});
serveur.requestTimeout = 300000;

const adresseLocale = `http://localhost:${cfg.port}`;
serveur.on('error', async e => {
  if (e.code !== 'EADDRINUSE') { console.error(`Démarrage impossible : ${e.message}`); process.exit(1); }
  try {
    const r = await fetch(`${adresseLocale}/api/etat`, { signal: AbortSignal.timeout(3000) });
    const etat = await r.json();
    if (etat && etat.version) {
      console.log('Comptabilité Nowis fonctionne déjà sur cet ordinateur.');
      if (process.argv.includes('--ouvrir')) ouvrirNavigateur(adresseLocale);
      process.exit(0);
    }
  } catch { /* un autre programme utilise ce port */ }
  console.error(`Le port ${cfg.port} est déjà utilisé par un autre programme. Choisissez un autre "port" dans config.json.`);
  process.exit(1);
});

serveur.listen(cfg.port, cfg.reseau ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(`\nComptabilité Nowis ${VERSION} est prêt : ${adresseLocale}`);
  console.log(`Données : ${DONNEES}`);
  if (cfg.reseau) {
    console.log('Accès réseau activé (protégé par le code d\'accès). Depuis le cellulaire, sur le même Wi-Fi :');
    for (const a of adressesReseau()) console.log(`  http://${a}:${cfg.port}`);
  }
  console.log(iaConfiguree() ? 'Agent NoWIS : branché.' : 'Agent NoWIS : non branché (voir LISEZ-MOI).');
  console.log(etatCopie.dossier ? (etatCopie.erreur ? `Copie hors de l'ordinateur : ÉCHEC (${etatCopie.erreur}).` : `Copie hors de l'ordinateur : ${etatCopie.dossier} (toutes les 3 heures).`) : 'Copie hors de l\'ordinateur : non configurée (voir LISEZ-MOI).');
  console.log(courrielConfigure() ? `Courriels : envoi activé (${cfg.courrielExpediteur}).` : 'Courriels : envoi non configuré.');
  if (courrielConfigure()) {
    const tour = () => { const h = new Date().getHours(); if (h >= 8 && h < 20) faireEnvois('Envoi automatique').catch(e => console.error(`Envois automatiques : ${e.message}`)); };
    setTimeout(tour, 20000);
    setInterval(tour, 30 * 60000).unref();
  }
  console.log(crmConfigure() ? `Synchronisation (${sourcesCrm().map(x => x.nom).join(', ')}) : au démarrage, puis toutes les ${cfg.crmMinutes} minutes.` : 'Synchronisation avec le CRM : non configurée.');
  if (crmConfigure()) {
    etatSync.active = true;
    setTimeout(synchroniser, 1500);
    setInterval(synchroniser, cfg.crmMinutes * 60000).unref();
  }
  console.log('\nLaissez cette fenêtre ouverte pendant que vous utilisez le logiciel. Fermez-la pour arrêter le serveur.\n');
  if (process.argv.includes('--ouvrir')) ouvrirNavigateur(adresseLocale);
});
