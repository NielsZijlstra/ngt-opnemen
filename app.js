// Opname-app voor de NGT-avatar: neemt gebaren op en bewaart ze op de iPad zelf.
// Met "Opnames versturen" gaan ze als één zip-bestand naar Niels.
'use strict';

const VERSIE = '20261009-2314';
const TAKES_DOEL = 3;

const $ = (id) => document.getElementById(id);
const wacht = (ms) => new Promise((r) => setTimeout(r, ms));

const staat = {
  gebaren: [],         // [{ id, woord, takes: [...], beste }]
  huidig: null,        // id van het gebaar dat open staat
  stream: null,
  bezig: false,
  laatsteOpname: null, // { blob, url, duur, breedte, hoogte, fps }
  wakeLock: null,
  videoUrls: [],       // object-URL's van het kiesscherm, om op te ruimen
  zip: null,           // { bestand: File, sleutels: [...] }
};

// --- instellingen (per apparaat onthouden) ----------------------------------

const instellingen = { aftellen: 5, duur: 4, camera: 'user', tipsGezien: false };

function laadInstellingen() {
  try {
    Object.assign(instellingen, JSON.parse(localStorage.getItem('ngt-opnemen') || '{}'));
  } catch (e) { /* geen opslag beschikbaar: standaardwaarden gebruiken */ }
}
function bewaarInstellingen() {
  try { localStorage.setItem('ngt-opnemen', JSON.stringify(instellingen)); } catch (e) { /* negeren */ }
}

// --- woordenlijst -------------------------------------------------------------

function leesCsv(tekst) {
  const rijen = [];
  let rij = [], veld = '', inAanhaling = false;
  for (let i = 0; i < tekst.length; i++) {
    const t = tekst[i];
    if (inAanhaling) {
      if (t === '"' && tekst[i + 1] === '"') { veld += '"'; i++; }
      else if (t === '"') inAanhaling = false;
      else veld += t;
    } else if (t === '"') inAanhaling = true;
    else if (t === ',') { rij.push(veld); veld = ''; }
    else if (t === '\n' || t === '\r') {
      if (t === '\r' && tekst[i + 1] === '\n') i++;
      rij.push(veld); veld = '';
      if (rij.some((v) => v !== '')) rijen.push(rij);
      rij = [];
    } else veld += t;
  }
  rij.push(veld);
  if (rij.some((v) => v !== '')) rijen.push(rij);
  const [kop, ...rest] = rijen;
  return rest.map((r) => Object.fromEntries(kop.map((k, i) => [k, r[i] || ''])));
}

async function laadGebaren() {
  const antwoord = await fetch('gebaren.csv');
  if (!antwoord.ok) throw new Error(`woordenlijst niet gevonden (${antwoord.status})`);
  const lijst = leesCsv(await antwoord.text());
  const { takes, beste } = await opslag.overzicht();
  staat.gebaren = lijst.map((g) => ({
    id: g.id,
    woord: g.woord,
    takes: takes[g.id] || [],
    beste: beste[g.id] ?? null,
  }));
}

function gebaar(id = staat.huidig) {
  return staat.gebaren.find((g) => g.id === id);
}

function alleTakes() {
  return staat.gebaren.flatMap((g) => g.takes);
}

// --- schermen -----------------------------------------------------------------

function toonScherm(naam) {
  document.querySelectorAll('.scherm').forEach((s) => s.classList.remove('actief'));
  $(`scherm-${naam}`).classList.add('actief');
  if (naam !== 'kiezen') ruimVideoUrlsOp();
  if (naam === 'overzicht') {
    stopCamera();
    tekenOverzicht();
  }
}

function stippen(aantal) {
  const vol = Math.min(aantal, TAKES_DOEL);
  return '●'.repeat(vol) + '○'.repeat(TAKES_DOEL - vol) + (aantal > TAKES_DOEL ? ' +' : '');
}

function tekenOverzicht() {
  const raster = $('raster');
  raster.innerHTML = '';
  for (const g of staat.gebaren) {
    const tegel = document.createElement('button');
    tegel.className = 'tegel' + (g.beste ? ' klaar' : '');
    tegel.innerHTML = `
      ${g.beste ? '<span class="tegel-ster">⭐</span>' : ''}
      <span class="tegel-woord"></span>
      <span class="tegel-stippen">${stippen(g.takes.length)}</span>`;
    tegel.querySelector('.tegel-woord').textContent = g.woord;
    tegel.addEventListener('click', () => openGebaar(g.id));
    raster.appendChild(tegel);
  }
  const klaar = staat.gebaren.filter((g) => g.beste).length;
  const totaal = staat.gebaren.length;
  $('voortgang-tekst').textContent = klaar === totaal && totaal > 0
    ? `Alle ${totaal} woorden klaar! 🎉`
    : `${klaar} van de ${totaal} woorden klaar`;
  $('voortgang-vulling').style.width = totaal ? `${(klaar / totaal) * 100}%` : '0';
  $('tips').classList.toggle('weg', instellingen.tipsGezien);

  const nieuw = alleTakes().filter((t) => !t.verstuurd).length;
  $('knop-versturen').textContent = nieuw ? `📤 Versturen (${nieuw} nieuw)` : '📤 Versturen';
}

async function openGebaar(id) {
  staat.huidig = id;
  tekenOpnemen();
  toonScherm('opnemen');
  await startCamera();
}

function tekenOpnemen() {
  const g = gebaar();
  $('opnemen-woord').textContent = g.woord;
  const n = g.takes.length;
  $('opnemen-stippen').textContent = `${stippen(n)}  ${n} van ${TAKES_DOEL} opnames${g.beste ? '  ⭐' : ''}`;
  $('knop-kiezen').classList.toggle('onzichtbaar', n === 0);
}

function volgendGebaar() {
  const i = staat.gebaren.findIndex((g) => g.id === staat.huidig);
  const rest = [...staat.gebaren.slice(i + 1), ...staat.gebaren.slice(0, i)];
  return rest.find((g) => !g.beste) || staat.gebaren[(i + 1) % staat.gebaren.length];
}

// --- camera -------------------------------------------------------------------

function cameraMelding(tekst) {
  const m = $('camera-melding');
  m.textContent = tekst || '';
  m.classList.toggle('zichtbaar', Boolean(tekst));
  $('knop-opnemen').disabled = Boolean(tekst);
}

async function startCamera() {
  if (staat.stream) return;
  if (!window.isSecureContext || !navigator.mediaDevices) {
    cameraMelding('De camera werkt alleen via een https-adres.');
    return;
  }
  cameraMelding('Camera wordt gestart…');
  const wens = {
    audio: false,
    video: {
      facingMode: instellingen.camera,
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 60 },
    },
  };
  try {
    try {
      staat.stream = await navigator.mediaDevices.getUserMedia(wens);
    } catch (e) {
      if (e.name !== 'OverconstrainedError') throw e;
      staat.stream = await navigator.mediaDevices.getUserMedia({
        audio: false, video: { facingMode: instellingen.camera },
      });
    }
  } catch (e) {
    cameraMelding(e.name === 'NotAllowedError'
      ? 'De app mag de camera nog niet gebruiken. Ga naar Instellingen → Safari → Camera en kies "Sta toe" of "Vraag". Open de app daarna opnieuw.'
      : `De camera kon niet starten (${e.name}).`);
    return;
  }
  const beeld = $('camera-beeld');
  beeld.srcObject = staat.stream;
  beeld.classList.toggle('spiegel', instellingen.camera === 'user');
  cameraMelding('');
  houdSchermWakker();
}

function stopCamera() {
  if (staat.stream) {
    staat.stream.getTracks().forEach((t) => t.stop());
    staat.stream = null;
    $('camera-beeld').srcObject = null;
  }
  if (staat.wakeLock) {
    staat.wakeLock.release().catch(() => {});
    staat.wakeLock = null;
  }
}

async function houdSchermWakker() {
  try {
    if ('wakeLock' in navigator && !staat.wakeLock) {
      staat.wakeLock = await navigator.wakeLock.request('screen');
      staat.wakeLock.addEventListener('release', () => { staat.wakeLock = null; });
    }
  } catch (e) { /* niet erg als dit niet lukt */ }
}

function kiesVideoFormaat() {
  const opties = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  return opties.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

// --- opnemen ------------------------------------------------------------------

async function neemOp() {
  if (staat.bezig || !staat.stream) return;
  staat.bezig = true;
  $('knop-opnemen').disabled = true;
  $('kader').classList.add('verborgen');

  // Aftellen
  const aftellen = $('aftellen');
  aftellen.classList.add('zichtbaar');
  for (let n = instellingen.aftellen; n > 0; n--) {
    aftellen.innerHTML = `${n}<small>Handen omlaag</small>`;
    await wacht(1000);
  }
  aftellen.classList.remove('zichtbaar');

  // Opnemen
  const formaat = kiesVideoFormaat();
  const stukjes = [];
  const recorder = new MediaRecorder(staat.stream, {
    ...(formaat ? { mimeType: formaat } : {}),
    videoBitsPerSecond: 8_000_000,
  });
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) stukjes.push(e.data); };
  const gestopt = new Promise((r) => { recorder.onstop = r; });

  const rand = $('opname-rand');
  const vulling = $('opname-tijd-vulling');
  rand.classList.add('zichtbaar');
  const duurMs = instellingen.duur * 1000;
  const begin = performance.now();
  recorder.start(500);

  await new Promise((klaar) => {
    function stap(nu) {
      const deel = Math.min((nu - begin) / duurMs, 1);
      vulling.style.width = `${deel * 100}%`;
      if (deel < 1) requestAnimationFrame(stap); else klaar();
    }
    requestAnimationFrame(stap);
  });
  recorder.stop();
  await gestopt;
  rand.classList.remove('zichtbaar');
  vulling.style.width = '0';

  const type = (recorder.mimeType || formaat || 'video/mp4').split(';')[0];
  const blob = new Blob(stukjes, { type });
  const instelling = staat.stream.getVideoTracks()[0].getSettings();
  staat.laatsteOpname = {
    blob,
    url: URL.createObjectURL(blob),
    duur: (performance.now() - begin) / 1000,
    breedte: instelling.width || null,
    hoogte: instelling.height || null,
    fps: instelling.frameRate || null,
  };

  staat.bezig = false;
  $('knop-opnemen').disabled = false;
  $('kader').classList.remove('verborgen');
  toonTerugkijken();
}

function toonTerugkijken() {
  $('terugkijken-woord').textContent = gebaar().woord;
  $('melding-terugkijken').textContent = '';
  $('knop-bewaren').disabled = false;
  const video = $('terugkijken-video');
  video.src = staat.laatsteOpname.url;
  toonScherm('terugkijken');
  video.play().catch(() => {});
}

function gooiLaatsteOpnameWeg() {
  if (staat.laatsteOpname) URL.revokeObjectURL(staat.laatsteOpname.url);
  staat.laatsteOpname = null;
  $('terugkijken-video').removeAttribute('src');
}

async function bewaar() {
  const opname = staat.laatsteOpname;
  if (!opname) return;
  $('knop-bewaren').disabled = true;
  const g = gebaar();
  const nummer = Math.max(0, ...g.takes.map((t) => t.nummer)) + 1;
  const ext = opname.blob.type.includes('mp4') ? 'mp4' : 'webm';
  try {
    const take = await opslag.bewaarTake({
      sleutel: `${g.id}/${nummer}`,
      gebaar: g.id,
      nummer,
      bestand: `take-${nummer}.${ext}`,
      tijd: new Date().toISOString(),
      bytes: opname.blob.size,
      breedte: opname.breedte,
      hoogte: opname.hoogte,
      fps: opname.fps,
      duur: Math.round(opname.duur * 100) / 100,
      verstuurd: null,
      blob: opname.blob,
    });
    g.takes.push(take);
  } catch (e) {
    $('melding-terugkijken').textContent = `Bewaren lukte niet (${e.message}). Is de iPad vol?`;
    $('knop-bewaren').disabled = false;
    return;
  }
  opslag.vraagBlijvendeOpslag();
  gooiLaatsteOpnameWeg();
  if (g.takes.length >= TAKES_DOEL && !g.beste) {
    openKiezen();
  } else {
    tekenOpnemen();
    toonScherm('opnemen');
  }
}

// --- beste kiezen -------------------------------------------------------------

function ruimVideoUrlsOp() {
  staat.videoUrls.forEach((u) => URL.revokeObjectURL(u));
  staat.videoUrls = [];
}

function openKiezen() {
  tekenKiezen();
  toonScherm('kiezen');
}

async function tekenKiezen() {
  const g = gebaar();
  $('kiezen-woord').textContent = g.woord;
  ruimVideoUrlsOp();
  const lijst = $('takes');
  lijst.innerHTML = '';
  if (!g.takes.length) {
    lijst.innerHTML = '<p class="uitleg">Nog geen opnames.</p>';
    return;
  }
  for (const take of g.takes) {
    const isBeste = g.beste === take.nummer;
    const kaart = document.createElement('div');
    kaart.className = 'take' + (isBeste ? ' beste' : '');
    kaart.innerHTML = `
      <video autoplay muted loop playsinline></video>
      <div class="take-knoppen">
        <button class="knop knop-ster">${isBeste ? '⭐ De beste' : '☆ Kies deze'}</button>
        <button class="knop knop-wis" aria-label="Wissen">🗑</button>
      </div>`;
    kaart.querySelector('.knop-ster').addEventListener('click', () => kiesBeste(take.nummer));
    kaart.querySelector('.knop-wis').addEventListener('click', () => wis(take.nummer));
    lijst.appendChild(kaart);
    const blob = await opslag.video(take.sleutel);
    if (blob) {
      const url = URL.createObjectURL(blob);
      staat.videoUrls.push(url);
      kaart.querySelector('video').src = url;
    }
  }
}

async function kiesBeste(nummer) {
  try {
    await opslag.kiesBeste(staat.huidig, nummer);
  } catch (e) {
    alert(`Dat lukte niet: ${e.message}`);
    return;
  }
  gebaar().beste = nummer;
  tekenKiezen();
}

async function wis(nummer) {
  if (!confirm('Deze opname wissen? Dit kan niet ongedaan worden.')) return;
  try {
    await opslag.wisTake(staat.huidig, nummer);
  } catch (e) {
    alert(`Wissen lukte niet: ${e.message}`);
    return;
  }
  const g = gebaar();
  g.takes = g.takes.filter((t) => t.nummer !== nummer);
  if (g.beste === nummer) g.beste = null;
  tekenKiezen();
}

// --- versturen ----------------------------------------------------------------

function mb(bytes) {
  return `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`;
}

function exportKeuze() {
  return document.querySelector('input[name="welke"]:checked').value;
}

function gekozenTakes(keuze = exportKeuze()) {
  return staat.gebaren.flatMap((g) => g.takes.filter((t) =>
    keuze === 'alle' || (keuze === 'nieuw' && !t.verstuurd) || (keuze === 'beste' && t.nummer === g.beste)));
}

function openVersturen() {
  staat.zip = null;
  document.querySelector('input[name="welke"][value="nieuw"]').checked = true;
  tekenVersturen();
  toonScherm('versturen');
}

function tekenVersturen() {
  const takes = alleTakes();
  const nieuw = takes.filter((t) => !t.verstuurd).length;
  const woorden = staat.gebaren.filter((g) => g.takes.length).length;
  $('versturen-samenvatting').textContent = takes.length
    ? `${takes.length} opnames van ${woorden} woorden. ${nieuw ? `${nieuw} daarvan zijn nog niet verstuurd.` : 'Alles is al een keer verstuurd.'}`
    : 'Er zijn nog geen opnames.';

  for (const keuze of ['nieuw', 'alle', 'beste']) {
    const lijst = gekozenTakes(keuze);
    $(`grootte-${keuze}`).textContent = lijst.length
      ? `${lijst.length} opnames, ongeveer ${mb(lijst.reduce((s, t) => s + t.bytes, 0))}`
      : 'geen opnames';
  }

  $('knop-zip-maken').disabled = takes.length === 0;
  $('stap-maken').classList.toggle('verborgen', Boolean(staat.zip));
  $('stap-delen').classList.toggle('verborgen', !staat.zip);
  $('zip-voortgang').classList.add('verborgen');
  $('melding-versturen').textContent = '';
}

function exportNaam() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `ngt-opnames-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.zip`;
}

async function maakExport() {
  const keuze = exportKeuze();
  const takes = gekozenTakes(keuze);
  if (!takes.length && keuze !== 'nieuw') {
    $('melding-versturen').textContent = 'Er is nog geen opname gekozen als beste.';
    return;
  }
  // Bij "alleen nieuwe" zonder nieuwe opnames gaan alleen de ⭐-keuzes mee
  $('knop-zip-maken').disabled = true;
  const balk = $('zip-voortgang');
  balk.classList.remove('verborgen');
  const vulling = $('zip-vulling');

  try {
    const bestanden = [];
    for (const take of takes) {
      const blob = await opslag.video(take.sleutel);
      if (blob) bestanden.push({ naam: `opnames/${take.gebaar}/${take.bestand}`, blob });
    }
    // Per woord een info.json, in hetzelfde formaat als op de Mac. Bij "alleen
    // nieuwe" voor elk woord met opnames, zodat een later gekozen ⭐ ook meegaat.
    for (const g of staat.gebaren) {
      const mee = takes.filter((t) => t.gebaar === g.id);
      if (!mee.length && !(keuze === 'nieuw' && g.takes.length)) continue;
      const info = {
        woord: g.woord,
        takes: mee.map(({ sleutel, gebaar: _, verstuurd, ...t }) => t),
        beste: g.beste,
      };
      bestanden.push({
        naam: `opnames/${g.id}/info.json`,
        blob: new Blob([JSON.stringify(info, null, 2)], { type: 'application/json' }),
      });
    }
    bestanden.push({
      naam: 'export.json',
      blob: new Blob([JSON.stringify({ versie: VERSIE, gemaakt: new Date().toISOString(), aantal: takes.length }, null, 2)]),
    });

    const zip = await maakZip(bestanden, (deel) => { vulling.style.width = `${deel * 100}%`; });
    staat.zip = {
      bestand: new File([zip], exportNaam(), { type: 'application/zip' }),
      sleutels: takes.map((t) => t.sleutel),
    };
  } catch (e) {
    $('melding-versturen').textContent = `Het bestand maken lukte niet (${e.message}).`;
    $('knop-zip-maken').disabled = false;
    balk.classList.add('verborgen');
    return;
  }
  tekenVersturen();
  $('zip-naam').textContent = `${staat.zip.bestand.name} (${mb(staat.zip.bestand.size)})`;
}

async function deelExport() {
  const { bestand, sleutels } = staat.zip;
  const melding = $('melding-versturen');
  if (navigator.canShare && navigator.canShare({ files: [bestand] })) {
    try {
      await navigator.share({ files: [bestand] });
    } catch (e) {
      if (e.name === 'AbortError') return; // menu gesloten zonder te kiezen
      melding.textContent = `Delen lukte niet (${e.message}). Probeer "Downloaden".`;
      return;
    }
  } else {
    downloadExport();
    return;
  }
  await bijVerstuurd(sleutels);
}

function downloadExport() {
  const { bestand, sleutels } = staat.zip;
  const url = URL.createObjectURL(bestand);
  const a = document.createElement('a');
  a.href = url;
  a.download = bestand.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  bijVerstuurd(sleutels);
}

async function bijVerstuurd(sleutels) {
  const tijd = new Date().toISOString();
  await opslag.markeerVerstuurd(sleutels);
  const set = new Set(sleutels);
  alleTakes().forEach((t) => { if (set.has(t.sleutel)) t.verstuurd = tijd; });
  $('melding-versturen').textContent = 'Gelukt! Laat Niels weten dat het bestand klaarstaat.';
}

// --- knoppen ------------------------------------------------------------------

function koppelKnoppen() {
  document.querySelectorAll('[data-naar]').forEach((k) =>
    k.addEventListener('click', () => toonScherm(k.dataset.naar)));

  $('knop-opnemen').addEventListener('click', neemOp);
  $('knop-kiezen').addEventListener('click', openKiezen);
  $('knop-volgende').addEventListener('click', () => {
    staat.huidig = volgendGebaar().id;
    tekenOpnemen();
  });

  $('knop-opnieuw').addEventListener('click', () => {
    gooiLaatsteOpnameWeg();
    toonScherm('opnemen');
  });
  $('knop-bewaren').addEventListener('click', bewaar);

  $('knop-kiezen-terug').addEventListener('click', async () => {
    if (gebaar().beste) {
      toonScherm('overzicht');
    } else {
      tekenOpnemen();
      toonScherm('opnemen');
      await startCamera();
    }
  });

  $('knop-versturen').addEventListener('click', openVersturen);
  document.querySelectorAll('input[name="welke"]').forEach((r) =>
    r.addEventListener('change', () => { staat.zip = null; tekenVersturen(); }));
  $('knop-zip-maken').addEventListener('click', maakExport);
  $('knop-delen').addEventListener('click', deelExport);
  $('knop-downloaden').addEventListener('click', downloadExport);

  $('knop-tips-weg').addEventListener('click', () => {
    instellingen.tipsGezien = true;
    bewaarInstellingen();
    $('tips').classList.add('weg');
  });

  const dialoog = $('instellingen');
  $('knop-instellingen').addEventListener('click', () => {
    $('instelling-aftellen').value = String(instellingen.aftellen);
    $('instelling-duur').value = String(instellingen.duur);
    $('instelling-camera').value = instellingen.camera;
    dialoog.showModal();
  });
  $('instelling-aftellen').addEventListener('change', (e) => {
    instellingen.aftellen = Number(e.target.value); bewaarInstellingen();
  });
  $('instelling-duur').addEventListener('change', (e) => {
    instellingen.duur = Number(e.target.value); bewaarInstellingen();
  });
  $('instelling-camera').addEventListener('change', (e) => {
    instellingen.camera = e.target.value; bewaarInstellingen();
  });
  $('knop-tips-tonen').addEventListener('click', () => {
    instellingen.tipsGezien = false;
    bewaarInstellingen();
    dialoog.close();
    tekenOverzicht();
  });
  $('versie').textContent = `Versie ${VERSIE}`;

  // Scherm weer wakker houden als de app terugkomt uit de achtergrond
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && staat.stream) houdSchermWakker();
  });
}

// Op iPad in Safari (niet vanaf het beginscherm) kan Safari opgeslagen
// gegevens na een tijd opruimen. Vanaf het beginscherm gebeurt dat niet.
function toonBeginschermTip() {
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const vanafBeginscherm = navigator.standalone === true
    || window.matchMedia('(display-mode: standalone)').matches;
  $('beginscherm-tip').classList.toggle('verborgen', !isIos || vanafBeginscherm);
}

// --- start --------------------------------------------------------------------

async function start() {
  laadInstellingen();
  koppelKnoppen();
  toonBeginschermTip();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  try {
    await laadGebaren();
  } catch (e) {
    $('melding-overzicht').textContent = `De app kon niet starten (${e.message}). Probeer de pagina te herladen.`;
    return;
  }
  tekenOverzicht();
}

start();
