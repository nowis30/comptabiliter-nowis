(function(){
"use strict";
/* Pont entre l'application et le serveur local : remplace le stockage de la version en ligne. */
const COLS=["ecritures","reglages","formulaires","contacts","documents","recurrences","trajets","annexes","journal","comptes","immobilisations","rapprochements"];
const L={};let D={},E={},connecte=true,msg="";
const H={"Content-Type":"application/json","X-Compta":"1"};
async function api(m,u,b){let r;try{r=await fetch(u,{method:m,headers:H,body:b===undefined?undefined:JSON.stringify(b),cache:"no-store"})}catch(e){throw{code:"unavailable",message:"Le serveur local ne répond pas."}}
  if(r.status===401){location.href="/connexion";throw{code:"not_granted",message:"Connexion requise."}}
  if(!r.ok){let j={};try{j=await r.json()}catch(e){}if(r.status===423){msg=j.message||"Période verrouillée.";setTimeout(barre,0)}throw{code:j.erreur||"unavailable",message:j.message||("Erreur "+r.status)}}
  return r.status===204?null:r.json()}
const clone=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x));
const META={fromCache:false,hasPendingWrites:false};
const snapDoc=(c,id)=>{const d=D[c]&&D[c][id];return{id,exists:!!d,data:()=>d?clone(d):undefined,metadata:META}};
const snapCol=c=>{const docs=Object.keys(D[c]||{}).map(id=>snapDoc(c,id));return{docs,size:docs.length,empty:!docs.length,metadata:META,docChanges:()=>[]}};
const emit=c=>(L[c]||[]).forEach(f=>setTimeout(f,0));
const lien=(c,id)=>"/api/c/"+c+"/"+encodeURIComponent(id);
const enDataUrl=b=>new Promise((ok,ko)=>{if(!/^image\/(jpeg|png|webp)$/.test(b.type||""))return ko({code:"image_rejected",message:"Format d'image non accepté."});const f=new FileReader();f.onload=()=>ok(f.result);f.onerror=()=>ko({code:"image_rejected"});f.readAsDataURL(b)});

const init=(async()=>{const [d,e]=await Promise.all([api("GET","/api/donnees"),api("GET","/api/etat")]);D=d||{};E=e||{};
  COLS.forEach(c=>{D[c]=D[c]||{}});
  brancherAgent();
  window.comptaServeur={etat:()=>E,historique:q=>api("GET","/api/historique?"+new URLSearchParams(Object.entries(q||{}).filter(([k,v])=>v!==undefined&&v!=="").map(([k,v])=>[k,String(v)]))),
    clotures:()=>api("GET","/api/clotures"),cloturer:a=>api("POST","/api/cloturer",{annee:String(a)}),courrielEssai:a=>api("POST","/api/courriel/essai",{a}),
    envoisPrevus:()=>api("GET","/api/envois/prevus"),envoisExecuter:()=>api("POST","/api/envois/executer")};
  ouvrirFlux();barre();return true})();

function brancherAgent(){window.agentNowis=E.ia?{pdf:false,json:async(prompt,images)=>{const im=[];for(const b of images||[])im.push(await enDataUrl(b));return api("POST","/api/ia",{prompt,images:im})}}:null}
function ouvrirFlux(){const es=new EventSource("/api/evenements");let ouvert=false;
  es.onopen=async()=>{if(ouvert&&!connecte){try{const [d,e]=await Promise.all([api("GET","/api/donnees"),api("GET","/api/etat")]);E=e||{};brancherAgent();COLS.forEach(c=>{D[c]=d[c]||{};emit(c)})}catch(e){}}ouvert=true;connecte=true;barre()};
  es.onerror=()=>{connecte=false;barre()};
  es.addEventListener("sync",ev=>{try{E.sync=JSON.parse(ev.data);barre()}catch(e){}});
  es.addEventListener("change",async ev=>{let c="";try{c=JSON.parse(ev.data).col}catch(e){}if(!COLS.includes(c))return;try{D[c]=await api("GET","/api/c/"+c);emit(c)}catch(e){}})}

const docRef=(c,id)=>({id,path:c+"/"+id,
  get:async()=>{await init;return snapDoc(c,id)},
  set:async d=>{await init;await api("PUT",lien(c,id),d);(D[c]=D[c]||{})[id]=clone(d);emit(c)},
  update:async d=>{await init;if(!D[c]||!D[c][id])throw{code:"invalid_argument",message:"Document absent."};await api("PATCH",lien(c,id),d);D[c][id]={...D[c][id],...clone(d)};emit(c)},
  delete:async()=>{await init;await api("DELETE",lien(c,id));if(D[c])delete D[c][id];emit(c)},
  onSnapshot:(cb,err)=>{const f=()=>cb(snapDoc(c,id));(L[c]=L[c]||[]).push(f);init.then(f,e=>{if(err)err(e)});return()=>{L[c]=(L[c]||[]).filter(x=>x!==f)}}});
const db={doc:p=>{const [c,id]=String(p).split("/");return docRef(c,id)},
  collection:c=>({doc:id=>docRef(c,id||("m-"+Date.now().toString(36)+Math.random().toString(36).slice(2,6))),get:async()=>{await init;return snapCol(c)},
    onSnapshot:(cb,err)=>{const f=()=>cb(snapCol(c));(L[c]=L[c]||[]).push(f);init.then(f,e=>{if(err)err(e)});return()=>{L[c]=(L[c]||[]).filter(x=>x!==f)}}})};
function telecharger(nom,data){const b=data instanceof Blob?data:new Blob([data],{type:"application/octet-stream"}),u=URL.createObjectURL(b),a=document.createElement("a");a.href=u;a.download=nom;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),4000)}
const assets={upload:async(blob,o)=>{const type=(o&&o.type)||blob.type||"";let r;try{r=await fetch("/api/fichiers",{method:"POST",headers:{"Content-Type":type,"X-Compta":"1"},body:blob})}catch(e){throw{code:"store_unavailable"}}
    if(r.status===401){location.href="/connexion";throw{code:"not_granted"}}const j=await r.json().catch(()=>({}));if(!r.ok)throw{code:j.erreur||"store_unavailable",message:j.message};return j},
  list:async()=>({assets:[],usage:{}}),delete:async()=>undefined};
window.claude={use:async n=>n==="db"?db:n==="downloads"?{save:async({filename,data})=>{telecharger(filename,data);return{status:"saved"}}}:n==="assets"?assets:null};

let attente=null;
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function barre(){let el=document.getElementById("serveurlocal");const h=document.querySelector("header.top");if(!h)return;
  if(!el){el=document.createElement("div");el.id="serveurlocal";el.className="info small";el.style.cssText="display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center";h.parentNode.insertBefore(el,h.nextSibling);
    el.addEventListener("click",async e=>{const b=e.target.closest("button");if(!b)return;msg="";
      if(b.dataset.a==="sv")location.href="/api/sauvegarde";
      else if(b.dataset.a==="rs")document.getElementById("sl-file").click();
      else if(b.dataset.a==="an"){attente=null;barre()}
      else if(b.dataset.a==="sy"){b.disabled=true;b.textContent="Synchronisation…";try{E.sync=await api("POST","/api/synchroniser")}catch(x){msg="Synchronisation impossible : "+(x.message||"erreur")}barre()}
      else if(b.dataset.a==="ap"){try{const r=await api("POST","/api/restaurer",attente);msg=`Sauvegarde restaurée : ${r.ecritures} écritures. L'état précédent est gardé dans ${r.copie_precedente}.`}catch(x){msg="Restauration impossible : "+(x.message||"erreur")}attente=null;barre()}});
    el.addEventListener("change",e=>{const f=e.target.files&&e.target.files[0];if(e.target.id!=="sl-file"||!f)return;const r=new FileReader();
      r.onload=()=>{try{const x=JSON.parse(r.result);if(!x||typeof x.ecritures!=="object")throw 0;attente=x}catch(z){attente=null;msg="Ce fichier n'est pas une sauvegarde de Comptabilité Nowis."}barre()};r.readAsText(f);e.target.value=""})}
  if(attente){el.innerHTML=`<span><b>Remplacer toutes vos données par les ${Object.keys(attente.ecritures).length} écritures de cette sauvegarde${attente.enregistre?" du "+esc(new Date(attente.enregistre).toLocaleString("fr-CA",{dateStyle:"medium",timeStyle:"short"})):""} ?</b> Une copie de l'état actuel sera gardée.</span><button data-a="ap" class="danger">Oui, remplacer</button><button data-a="an">Annuler</button>`;return}
  el.innerHTML=`<span style="flex:1 1 280px">${connecte?`Serveur local · données dans <b>${esc(E.dossier||"le dossier donnees")}</b> · copie de sécurité automatique chaque jour.${copieTexte()}${E.adresses&&E.adresses.length?` Sur votre cellulaire (même Wi-Fi) : ${E.adresses.map(esc).join(" ou ")}`:""}`:`<b>Le serveur local ne répond plus.</b> Vérifiez que la fenêtre « Comptabilité Nowis » est toujours ouverte; la page se reconnectera toute seule.`} ${esc(msg)}</span>
   ${E.sync&&E.sync.active?`<span style="flex:1 1 100%">${syncTexte()}</span><button data-a="sy" ${E.sync.enCours?"disabled":""}>${E.sync.enCours?"Synchronisation…":"Synchroniser maintenant"}</button>`:""}
   <button data-a="sv">Télécharger une sauvegarde</button><button data-a="rs">Restaurer une sauvegarde</button><input type="file" id="sl-file" accept=".json,application/json" hidden>`}
function copieTexte(){const c=E.copie||{};if(!c.dossier)return " <b>Aucune copie hors de l'ordinateur</b> : voir « copie_externe » dans le LISEZ-MOI.";
  if(c.erreur)return ` <b>Copie hors de l'ordinateur impossible</b> : ${esc(c.erreur)}.`;
  return ` Copie hors de l'ordinateur dans <b>${esc(c.dossier)}</b>${c.derniere?" à "+esc(new Date(c.derniere).toLocaleTimeString("fr-CA",{hour:"2-digit",minute:"2-digit"})):""}.`}
function syncTexte(){const s=E.sync,noms=(s.sources||[]).map(x=>x.nom).join(" et ")||"CRM nowis.store";
  if(!s.derniere&&!s.erreur)return `${esc(noms)} : première synchronisation en cours…`;
  const r=s.resultat||{},h=s.derniere?new Date(s.derniere).toLocaleTimeString("fr-CA",{hour:"2-digit",minute:"2-digit"}):"",d=[r.nouvelles?r.nouvelles+" nouvelle(s)":"",r.misesAJour?r.misesAJour+" mise(s) à jour":"",r.contacts?r.contacts+" contact(s)":"",r.aVerifier?`<a href="#verifier">${r.aVerifier} à vérifier</a>`:""].filter(Boolean);
  const ok=(s.sources||[]).filter(x=>x.resultat).map(x=>x.nom);
  return `${ok.length?`${esc(ok.join(" et "))} : à jour à ${h}${d.length?" · dernière synchronisation : "+d.join(", "):""}.`:""}${s.erreur?` <b>Synchronisation impossible</b> — ${esc(s.erreur)}. Vos données locales restent utilisables.`:""}`}
setInterval(()=>{if(E.sync&&E.sync.active&&!attente&&!document.querySelector("#serveurlocal button[data-a=sy][disabled]"))barre()},60000);
document.addEventListener("DOMContentLoaded",barre);
})();
