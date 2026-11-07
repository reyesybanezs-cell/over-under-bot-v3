require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const schedule = require('node-schedule');

// ==================================================================
// CONFIGURACIÓN
// ==================================================================

const app = express();
const PORT = process.env.PORT || 3000;
const ODDS_API_KEY = process.env.THE_ODDS_API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || 'cambia-este-secreto';
const GOOGLE_SHEETS_WEBHOOK_URL = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
const GOOGLE_SHEETS_SECRETO = process.env.GOOGLE_SHEETS_SECRETO || 'cambia-este-secreto';

// FotMob auto-fill
const FOTMOB_ENABLED = process.env.FOTMOB_ENABLED !== 'false';
const FOTMOB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FOTMOB_HORAS_CRON = [0, 3, 6, 9, 12, 15, 18, 21];
const FOTMOB_UMBRAL_HORAS_OVER = 3;
const FOTMOB_UMBRAL_HORAS_ABORTADO = 2;

const DB_PATH = path.join(__dirname, 'database.json');
const PRIORS_LOCAL_PATH = path.join(__dirname, 'priors.json');

const LIGAS_PERMITIDAS = [
  'soccer_epl', 'soccer_efl_champ', 'soccer_germany_bundesliga', 'soccer_spain_la_liga',
  'soccer_italy_serie_a', 'soccer_france_ligue_one', 'soccer_netherlands_eredivisie',
  'soccer_portugal_primeira_liga', 'soccer_brazil_campeonato', 'soccer_mexico_ligamx',
  'soccer_usa_mls', 'soccer_argentina_primera_division', 'soccer_uefa_champs_league',
  'soccer_germany_bundesliga2',
  'soccer_uefa_europa_league',
];

const CHECKPOINTS = [
  { clave: '24h', ms: 24 * 3600000 },
  { clave: '1h', ms: 1 * 3600000 },
  { clave: '5m', ms: 5 * 60000 },
];

const LINEAS_A_RASTREAR = [1.5, 2.5, 3.5, 4.5];
const LINEAS_XG = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.5, 7.5];
const LINEA_PRINCIPAL = '3.5';
const VERSION_REGLA = 'v4.9';

const UMBRAL_ABORTO_CUOTA = 2.30;
const UMBRAL_XG_24H_MIN = 2.10;
const UMBRAL_XG_CONTRADICE = 2.60;
const UMBRAL_CASAS_MIN = 3;
const UMBRAL_CASAS_PEAJE = 5;
const UMBRAL_SCORE_OVER = 55;
const UMBRAL_PROMETEDOR_CUOTA = 2.05;

const UMBRAL_PRIOR_OVER_RATE_MIN = 0.25;
const UMBRAL_PRIOR_PARTIDOS_MIN = 8;
const PREFILTRO_BULK_MIN_CANDIDATOS = 2;
const PREFILTRO_BULK_CUOTA_MAX = 2.35;

const GAP_MINIMO_MS = (0 * 60 + 60) * 60000;
const VENTANA_INICIO_MIN = 6 * 60;
const VENTANA_FIN_MIN = 23 * 60 + 30;
const OBJETIVO_MENSUAL_ACTIVOS = 120;

// C1: si fallan 3 intentos de API, abortar en vez de quedar colgado
const INTENTOS_API_MAX = 3;
const ESPERA_REINTENTO_MS = 30000;

// C5: reemplazos hasta T-6h (antes era T-24h)
const VENTANA_REEMPLAZO_MS = 6 * 3600000;

// v4.9 Fix 2: margen mínimo para que el peaje del reemplazo corra en el futuro
const MARGEN_PEAJE_REEMPLAZO_MS = 30 * 60000; // 30 min

// v4.9 Fix 1: delay para peaje atrasado (evita race condition con guardarDB)
const DELAY_PEAJE_ATRASADO_MS = 5000; // 5s

const HORA_BUSQUEDA_DIARIA = process.env.HORA_BUSQUEDA_DIARIA || '05:00';
const ZONA_HORARIA = process.env.ZONA_HORARIA || 'America/Lima';

let trabajosActivos = {};
let PRIORS = null;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================================================================
// PRIORS
// ==================================================================

async function cargarPriors() {
  if (GOOGLE_SHEETS_WEBHOOK_URL) {
    try {
      const res = await fetch(`${GOOGLE_SHEETS_WEBHOOK_URL}?secreto=${encodeURIComponent(GOOGLE_SHEETS_SECRETO)}&tipo=priors`);
      const data = await res.json();
      if (data.ok && data.priors) {
        const parsed = typeof data.priors === 'string' ? JSON.parse(data.priors) : data.priors;
        console.log(`📊 Priors cargados desde Sheets (${Object.keys(parsed.porLiga || {}).length} ligas)`);
        return parsed;
      }
    } catch (err) {}
  }
  try {
    if (fs.existsSync(PRIORS_LOCAL_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(PRIORS_LOCAL_PATH, 'utf-8'));
      console.log(`📊 Priors cargados desde archivo local (${Object.keys(parsed.porLiga || {}).length} ligas)`);
      return parsed;
    }
  } catch (err) {}
  console.log('📊 Sin priors — todos los partidos pasan el filtro');
  return null;
}

function ligaEsElegible(sportKey) {
  if (!PRIORS || !PRIORS.porLiga) return true;
  const info = PRIORS.porLiga[sportKey];
  if (!info) return true;
  if ((info.partidos || 0) < UMBRAL_PRIOR_PARTIDOS_MIN) return true;
  if ((info.overRate || 0) < UMBRAL_PRIOR_OVER_RATE_MIN) return false;
  return true;
}

// ==================================================================
// BASE DE DATOS
// ==================================================================

function leerDB() {
  if (!fs.existsSync(DB_PATH)) return { partidos: {}, calendarioDia: [] };
  try {
    const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8') || '{}');
    if (!data.partidos) data.partidos = {};
    if (!data.calendarioDia) data.calendarioDia = [];
    return data;
  } catch (err) {
    return { partidos: {}, calendarioDia: [] };
  }
}

function guardarDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
  enviarASheets({ tipo: 'estado', datos: JSON.stringify(data) }).catch(() => {});
}

let colaOperacionesDB = Promise.resolve();
function conBloqueoDB(tarea) {
  const resultado = colaOperacionesDB.then(tarea, tarea);
  colaOperacionesDB = resultado.then(() => {}, () => {});
  return resultado;
}

function limpiarJobsPartido(matchId) {
  for (const cp of CHECKPOINTS.map(c => c.clave)) {
    const key = `${matchId}_${cp}`;
    if (trabajosActivos[key]) {
      try { trabajosActivos[key].cancel(); } catch (e) {}
      delete trabajosActivos[key];
    }
  }
  const keyM = `${matchId}_marcador`;
  if (trabajosActivos[keyM]) {
    try { trabajosActivos[keyM].cancel(); } catch (e) {}
    delete trabajosActivos[keyM];
  }
}

// ==================================================================
// FOTMOB
// ==================================================================

function normalizarEquipo(nombre) {
  return String(nombre || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[.']/g, '')
    .replace(/^(fc|cf|sc|ac|as|ss|ssc|rc|cd|ud|ca)\s+/i, '')
    .replace(/\s+(fc|cf|sc|ac|as|ss|ssc|rc|cd|ud|ca|club)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function equiposCoinciden(a, b) {
  const na = normalizarEquipo(a);
  const nb = normalizarEquipo(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

function fechasFotMobARevisar(isoString) {
  const base = new Date(isoString).getTime();
  const fechas = [];
  for (let offset = -1; offset <= 1; offset++) {
    const d = new Date(base + offset * 86400000);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    fechas.push(`${yyyy}${mm}${dd}`);
  }
  return fechas;
}

async function obtenerPartidosFotMob(fechaStr) {
  try {
    const res = await fetch(`https://www.fotmob.com/api/data/matches?date=${fechaStr}`, {
      headers: {
        'User-Agent': FOTMOB_UA,
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.fotmob.com/',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.warn(`⚠️ FotMob ${fechaStr}: HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    const todos = [];
    for (const liga of data.leagues || []) {
      for (const m of liga.matches || []) {
        todos.push({
          id: m.id,
          homeNombre: m.home?.name || '',
          awayNombre: m.away?.name || '',
          homeScore: m.home?.score,
          awayScore: m.away?.score,
          timeTS: m.timeTS,
          finished: m.status?.finished === true,
          cancelled: m.status?.cancelled === true,
        });
      }
    }
    return todos;
  } catch (err) {
    console.warn(`⚠️ FotMob ${fechaStr}: ${err.message}`);
    return [];
  }
}

async function buscarPartidoEnFotMob(p, cacheFechas) {
  const fechas = fechasFotMobARevisar(p.commenceTime);
  const commenceMs = new Date(p.commenceTime).getTime();

  for (const fechaStr of fechas) {
    if (!cacheFechas[fechaStr]) {
      cacheFechas[fechaStr] = await obtenerPartidosFotMob(fechaStr);
      await new Promise(r => setTimeout(r, 300));
    }
    for (const m of cacheFechas[fechaStr]) {
      if (!m.finished || m.cancelled) continue;
      if (m.homeScore == null || m.awayScore == null) continue;
      if (Math.abs(m.timeTS - commenceMs) > 6 * 3600000) continue;
      if (equiposCoinciden(p.homeTeam, m.homeNombre) && equiposCoinciden(p.awayTeam, m.awayNombre)) {
        return m;
      }
    }
  }
  return null;
}

async function obtenerStatsPost(matchIdFotMob) {
  if (!matchIdFotMob) return null;
  try {
    const res = await fetch(`https://www.fotmob.com/api/data/matchDetails?matchId=${matchIdFotMob}`, {
      headers: {
        'User-Agent': FOTMOB_UA,
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.fotmob.com/'
      },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      console.warn(`⚠️ matchDetails ${matchIdFotMob}: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();

    const coverageLevel = data.general?.coverageLevel || 'desconocido';
    console.log(`📊 matchDetails ${matchIdFotMob}: coverageLevel=${coverageLevel}`);

    const topStats = data.content?.stats?.Periods?.All?.stats
      ?.find(s => s.key === 'top_stats')?.stats || [];

    const buscar = (key) => {
      const found = topStats.find(s => s.key === key);
      return found?.stats || [null, null];
    };

    const [xgHome, xgAway] = buscar('expected_goals');
    const [bcHome, bcAway] = buscar('big_chance');
    const [sotHome, sotAway] = buscar('ShotsOnTarget');

    const parseNum = (v, isFloat = true) => {
      if (v === null || v === undefined) return null;
      const n = isFloat ? parseFloat(v) : parseInt(v);
      return isNaN(n) ? null : n;
    };

    const status = data.header?.status || {};
    const redCardsHome = status.numberOfHomeRedCards ?? 0;
    const redCardsAway = status.numberOfAwayRedCards ?? 0;

    const eventos = data.content?.matchFacts?.events?.events || [];
    const rojasHome = eventos.filter(e =>
      e.type === 'Card' &&
      (e.card === 'Red' || e.card === 'YellowRed') &&
      e.isHome === true
    );
    const rojasAway = eventos.filter(e =>
      e.type === 'Card' &&
      (e.card === 'Red' || e.card === 'YellowRed') &&
      e.isHome === false
    );

    const minutoRojaHome = rojasHome.length > 0
      ? Math.min(...rojasHome.map(r => parseInt(r.timeStr) || 90))
      : null;
    const minutoRojaAway = rojasAway.length > 0
      ? Math.min(...rojasAway.map(r => parseInt(r.timeStr) || 90))
      : null;

    return {
      xgHomePost: parseNum(xgHome),
      xgAwayPost: parseNum(xgAway),
      bigChancesHome: parseNum(bcHome, false),
      bigChancesAway: parseNum(bcAway, false),
      shotsOnTargetHome: parseNum(sotHome, false),
      shotsOnTargetAway: parseNum(sotAway, false),
      redCardsHome,
      redCardsAway,
      minutoRojaHome,
      minutoRojaAway,
    };
  } catch (err) {
    console.warn(`⚠️ matchDetails ${matchIdFotMob}: ${err.message}`);
    return null;
  }
}

async function autoCompletarMarcadores() {
  if (!FOTMOB_ENABLED) {
    console.log('⏭️ FotMob deshabilitado (FOTMOB_ENABLED=false)');
    return { completados: 0, candidatos: 0 };
  }

  return conBloqueoDB(async () => {
    const db = leerDB();
    const ahora = Date.now();
    const cacheFechas = {};
    let completados = 0;
    let candidatos = 0;

    for (const id of Object.keys(db.partidos)) {
      const p = db.partidos[id];
      const commenceTime = new Date(p.commenceTime).getTime();
      const horasDesdeInicio = (ahora - commenceTime) / 3600000;

      const esCandidato =
        (p.estado === 'activo' && p.prediccion === 'OVER' && horasDesdeInicio > FOTMOB_UMBRAL_HORAS_OVER) ||
        (p.estado === 'abortado' && horasDesdeInicio > FOTMOB_UMBRAL_HORAS_ABORTADO);

      if (!esCandidato) continue;
      candidatos++;

      const resultado = await buscarPartidoEnFotMob(p, cacheFechas);
      if (!resultado) {
        console.log(`🔍 Sin match FotMob: ${p.homeTeam} vs ${p.awayTeam} (${p.commenceTime})`);
        continue;
      }

      const marcador = `${resultado.homeScore}-${resultado.awayScore}`;
      const goles = resultado.homeScore + resultado.awayScore;

      const statsPost = await obtenerStatsPost(resultado.id);
      const xgTxt = statsPost ? `xG ${statsPost.xgHomePost ?? '?'}-${statsPost.xgAwayPost ?? '?'}` : 'sin stats';
      const rojaTxt = statsPost && (statsPost.redCardsHome > 0 || statsPost.redCardsAway > 0)
        ? ` | 🟥 ${statsPost.redCardsHome}-${statsPost.redCardsAway}`
        : '';
      console.log(`⚽ FotMob: ${p.homeTeam} vs ${p.awayTeam} = ${marcador} (${xgTxt}${rojaTxt})`);

      const exito = await cerrarPartidoEnHistorial(p, marcador, statsPost || {});
      if (!exito) {
        console.error(`❌ Falló envío a Sheets: ${p.homeTeam} vs ${p.awayTeam}`);
        continue;
      }

      if (p.prediccion === 'OVER') {
        const res = goles > 3.5 ? '🎉 ¡Acertaste!' : '❌ Fallo.';
        await enviarTelegram(`✅ Auto-registrado (FotMob): ${marcador} (${goles} goles). ${res}\n⚽ ${p.homeTeam} vs ${p.awayTeam}`);
      }

      p.estado = 'cerrado';
      limpiarJobsPartido(id);
      delete db.partidos[id];
      completados++;
    }

    if (completados > 0) guardarDB(db);
    console.log(`🔍 FotMob auto-fill: ${completados}/${candidatos} completados`);
    return { completados, candidatos };
  });
}

async function backfillHistorial() {
  if (!FOTMOB_ENABLED || !GOOGLE_SHEETS_WEBHOOK_URL) {
    return { rellenados: 0, candidatos: 0 };
  }

  try {
    const res = await fetch(`${GOOGLE_SHEETS_WEBHOOK_URL}?secreto=${encodeURIComponent(GOOGLE_SHEETS_SECRETO)}`);
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.historial)) {
      console.log('⏭️ Backfill: sin historial para procesar');
      return { rellenados: 0, candidatos: 0 };
    }

    const filasVacias = data.historial.filter(h => {
      const marcadorVacio = !h.marcador || String(h.marcador).trim() === '';
      const partidoEmpezado = h.horaInicioReal && (Date.now() - new Date(h.horaInicioReal).getTime() > 2 * 3600000);
      const noMuyViejo = h.horaInicioReal && (Date.now() - new Date(h.horaInicioReal).getTime() < 30 * 86400000);
      return marcadorVacio && partidoEmpezado && noMuyViejo;
    });

    if (filasVacias.length === 0) {
      console.log('⏭️ Backfill: 0 filas pendientes');
      return { rellenados: 0, candidatos: 0 };
    }

    console.log(`🔍 Backfill: ${filasVacias.length} filas con marcador vacío`);

    const cacheFechas = {};
    let rellenados = 0;

    for (const h of filasVacias) {
      const pseudo = {
        homeTeam: h.equipoLocal,
        awayTeam: h.equipoVisitante,
        commenceTime: h.horaInicioReal
      };
      const resultado = await buscarPartidoEnFotMob(pseudo, cacheFechas);
      if (!resultado) {
        console.log(`🔍 Backfill sin match: ${h.equipoLocal} vs ${h.equipoVisitante}`);
        continue;
      }

      const marcador = `${resultado.homeScore}-${resultado.awayScore}`;
      const goles = resultado.homeScore + resultado.awayScore;
      const statsPost = await obtenerStatsPost(resultado.id) || {};

      const exito = await enviarASheets({
        tipo: 'actualizar-historial',
        partido: h.partido,
        horaInicioReal: h.horaInicioReal,
        marcador,
        golesTotales: goles,
        xgHomePost: statsPost.xgHomePost,
        xgAwayPost: statsPost.xgAwayPost,
        bigChancesHome: statsPost.bigChancesHome,
        bigChancesAway: statsPost.bigChancesAway,
        shotsOnTargetHome: statsPost.shotsOnTargetHome,
        shotsOnTargetAway: statsPost.shotsOnTargetAway,
        redCardsHome: statsPost.redCardsHome,
        redCardsAway: statsPost.redCardsAway,
        minutoRojaHome: statsPost.minutoRojaHome,
        minutoRojaAway: statsPost.minutoRojaAway,
      });

      if (exito) {
        console.log(`✅ Backfill actualizado: ${h.partido} = ${marcador}`);
        rellenados++;
      }
    }

    console.log(`🔍 Backfill: ${rellenados}/${filasVacias.length} rellenados`);
    return { rellenados, candidatos: filasVacias.length };

  } catch (err) {
    console.error(`❌ Backfill error: ${err.message}`);
    return { rellenados: 0, candidatos: 0, error: err.message };
  }
}

// ==================================================================
// LIMPIEZA DE PARTIDOS OBSOLETOS
// ==================================================================

async function limpiarPartidosObsoletos(db) {
  const ahora = Date.now();
  const partidosParaCerrar = [];
  let eliminados = 0;

  for (const id of Object.keys(db.partidos)) {
    const p = db.partidos[id];
    const commenceTime = new Date(p.commenceTime).getTime();
    const horasDesdeInicio = (ahora - commenceTime) / 3600000;

    let debeEliminar = false;
    let debeCerrarEnHistorial = false;
    let razon = '';

    if (p.estado === 'en_cola' && ahora >= commenceTime) {
      debeEliminar = true;
      razon = 'en_cola+iniciado';
    } else if (p.estado === 'activo' && !p.prediccionEnviada && ahora >= commenceTime) {
      debeEliminar = true;
      razon = 'activo+sin_pred';
    } else if (p.estado === 'activo' && p.prediccionEnviada && p.prediccion === 'OVER' && horasDesdeInicio > 48) {
      debeEliminar = true;
      debeCerrarEnHistorial = true;
      razon = 'over+48h';
    } else if (p.estado === 'activo' && p.prediccionEnviada && p.prediccion !== 'OVER' && horasDesdeInicio > 6) {
      debeEliminar = true;
      debeCerrarEnHistorial = true;
      razon = 'sin_apuesta+6h';
    } else if (p.estado === 'abortado' && horasDesdeInicio > 24) {
      debeEliminar = true;
      debeCerrarEnHistorial = true;
      razon = 'abortado+24h';
    }

    if (debeEliminar) {
      if (debeCerrarEnHistorial) partidosParaCerrar.push(p);
      limpiarJobsPartido(id);
      delete db.partidos[id];
      eliminados++;
      console.log(`🧹 [${razon}] ${p.homeTeam} vs ${p.awayTeam}`);
    }
  }

  for (const p of partidosParaCerrar) {
    try {
      await cerrarPartidoEnHistorial(p, "");
    } catch (err) {
      console.error('Error en cleanup historial:', err.message);
    }
  }

  return { eliminados, cerrados: partidosParaCerrar.length };
}

// ==================================================================
// COMUNICACIÓN EXTERNA
// ==================================================================

async function enviarASheets(payload) {
  if (!GOOGLE_SHEETS_WEBHOOK_URL) return false;
  try {
    const res = await fetch(GOOGLE_SHEETS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secreto: GOOGLE_SHEETS_SECRETO, ...payload }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error(`❌ Sheets: ${data.error || 'sin detalle'} | tipo=${payload.tipo || 'historial'} | ${payload.partido || ''}`);
    }
    return data.ok;
  } catch (err) {
    console.error(`❌ Sheets fetch error: ${err.message} | tipo=${payload.tipo || 'historial'}`);
    return false;
  }
}

async function recuperarEstadoSiHaceFalta() {
  const dbLocal = leerDB();
  if (Object.keys(dbLocal.partidos).length > 0 || !GOOGLE_SHEETS_WEBHOOK_URL) return;
  try {
    const res = await fetch(`${GOOGLE_SHEETS_WEBHOOK_URL}?secreto=${encodeURIComponent(GOOGLE_SHEETS_SECRETO)}&tipo=estado`);
    const data = await res.json();
    if (data.ok && data.estado) {
      const parseado = JSON.parse(data.estado);
      if (parseado.partidos && Object.keys(parseado.partidos).length > 0) {
        fs.writeFileSync(DB_PATH, JSON.stringify(parseado, null, 2), 'utf-8');
      }
    }
  } catch (err) {}
}

async function enviarTelegram(mensaje) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: mensaje }),
    });
    const data = await res.json();
    return data.ok ? data.result.message_id : null;
  } catch (err) {
    return null;
  }
}

async function configurarWebhookTelegram() {
  if (!TELEGRAM_TOKEN) return;
  const urlPublica = process.env.RENDER_EXTERNAL_URL;
  if (!urlPublica) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `${urlPublica}/api/telegram-webhook/${TELEGRAM_WEBHOOK_SECRET}` }),
  });
}

// ==================================================================
// THE ODDS API
// ==================================================================

async function obtenerEventosLiga(sportKey) {
  try {
    const res = await fetch(`https://api.the-odds-api.com/v4/sports/${sportKey}/events?apiKey=${ODDS_API_KEY}`);
    if (!res.ok) return [];
    const eventos = await res.json();
    return eventos.map((e) => ({ ...e, sportKey }));
  } catch (err) {
    return [];
  }
}

async function preEscanearLiga(sportKey) {
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?apiKey=${ODDS_API_KEY}&regions=eu&markets=alternate_totals&oddsFormat=decimal`;
  try {
    const res = await fetch(url);
    if (!res.ok) return {};
    const data = await res.json();
    const resumen = {};
    for (const partido of data) {
      const overs = [];
      for (const casa of partido.bookmakers || []) {
        const mercado = casa.markets?.find(m => m.key === 'alternate_totals');
        if (!mercado) continue;
        for (const out of mercado.outcomes || []) {
          if (out.point === 3.5 && out.name === 'Over') overs.push(out.price);
        }
      }
      resumen[partido.id] = overs.length ? (overs.reduce((a, b) => a + b, 0) / overs.length) : null;
    }
    return resumen;
  } catch (err) {
    return {};
  }
}

async function obtenerCuotasTotales(sportKey, eventId, claveCheckpoint) {
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${eventId}/odds?apiKey=${ODDS_API_KEY}&regions=eu&markets=alternate_totals&oddsFormat=decimal`;
  try {
    const res = await fetch(url);
    const creditosRestantes = res.headers.get('x-requests-remaining') || '';
    if (!res.ok) return null;
    const data = await res.json();

    const horaInicioApi = data.commence_time || '';
    const acumuladorPromedios = {};
    const filasCrudas = [];
    let pinnacle35 = { over: null, under: null };
    let casasEn35 = new Set();
    const fechaCaptura = new Date().toISOString();

    for (const p of [...new Set([...LINEAS_A_RASTREAR, ...LINEAS_XG])]) {
      acumuladorPromedios[String(p)] = { overs: [], unders: [] };
    }

    for (const casa of data.bookmakers || []) {
      const mercadoTotals = casa.markets?.find((m) => m.key === 'alternate_totals');
      if (!mercadoTotals) continue;
      const updateTime = casa.last_update;

      for (const outcome of mercadoTotals.outcomes) {
        const clave = String(outcome.point);
        const esOver = outcome.name === 'Over';

        if (acumuladorPromedios[clave]) {
          if (esOver) acumuladorPromedios[clave].overs.push(outcome.price);
          else acumuladorPromedios[clave].unders.push(outcome.price);
        }

        if (LINEAS_A_RASTREAR.includes(outcome.point) || LINEAS_XG.includes(outcome.point)) {
          const outcomePareja = mercadoTotals.outcomes.find(o => o.point === outcome.point && o.name !== outcome.name);
          if (esOver && outcomePareja) {
            filasCrudas.push({
              fechaCaptura, partidoId: eventId, chequeo: claveCheckpoint,
              casa: casa.title, linea: clave, cuotaOver: outcome.price,
              cuotaUnder: outcomePareja.price, ultimaActualizacion: updateTime
            });
            if (clave === LINEA_PRINCIPAL) {
              casasEn35.add(casa.title);
              if (casa.title.toLowerCase() === 'pinnacle') {
                pinnacle35 = { over: outcome.price, under: outcomePareja.price };
              }
            }
          }
        }
      }
    }

    const promedio = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    const lineasPromedio = {};
    for (const clave of Object.keys(acumuladorPromedios)) {
      const overs = acumuladorPromedios[clave].overs;
      const unders = acumuladorPromedios[clave].unders;
      if (overs.length && unders.length) {
        lineasPromedio[clave] = { over: Number(promedio(overs).toFixed(2)), under: Number(promedio(unders).toFixed(2)) };
      }
    }

    return { lineas: lineasPromedio, filasCrudas, creditosRestantes, pinnacle35, cantidadCasas: casasEn35.size, horaInicioApi };
  } catch (err) {
    return null;
  }
}

// ==================================================================
// CÁLCULOS
// ==================================================================

function calcularXGPoisson(lineas) {
  if (!lineas) return '';
  const observaciones = [];
  for (const [lineaStr, q] of Object.entries(lineas)) {
    if (!q?.over || !q?.under) continue;
    const pOverImpl = 1 / q.over;
    const pUnderImpl = 1 / q.under;
    const pOverMercado = pOverImpl / (pOverImpl + pUnderImpl);
    observaciones.push({ N: Math.floor(parseFloat(lineaStr)), pOver: pOverMercado });
  }
  if (observaciones.length < 4) return '';

  function cdfPoisson(lambda, N) {
    if (N < 0) return 0;
    let term = Math.exp(-lambda);
    let cdf = term;
    for (let k = 1; k <= N; k++) {
      term = term * lambda / k;
      cdf += term;
    }
    return cdf;
  }

  let mejorLambda = null;
  let mejorError = Infinity;
  for (let lam = 0.3; lam <= 7.001; lam += 0.05) {
    let error = 0;
    for (const obs of observaciones) {
      const diff = obs.pOver - (1 - cdfPoisson(lam, obs.N));
      error += diff * diff;
    }
    const mse = error / observaciones.length;
    if (mse < mejorError) { mejorError = mse; mejorLambda = lam; }
  }
  return mejorLambda !== null ? Number(mejorLambda.toFixed(2)) : '';
}

function lineaPrincipal(lineas) {
  if (!lineas) return null;
  let mejor = null, diff = Infinity;
  for (const [lStr, q] of Object.entries(lineas)) {
    if (!q?.over || !q?.under) continue;
    const d = Math.abs(q.over - q.under);
    if (d < diff) { diff = d; mejor = parseFloat(lStr); }
  }
  return mejor;
}

function scoreOver(p) {
  let score = 0;
  const opening = p.cuotas['24h']?.lineas?.[LINEA_PRINCIPAL]?.over;
  if (!opening) return 0;

  if      (opening < 1.90) score += 60;
  else if (opening < 2.05) score += 55;
  else if (opening < 2.20) score += 45;
  else if (opening < 2.30) score += 30;
  else if (opening < 2.40) score += 15;
  else                     return 0;

  const xg = (typeof p.xgCierre === 'number' && !isNaN(p.xgCierre)) ? p.xgCierre : null;
  if (xg !== null) {
    if      (xg >= 3.6) score += 25;
    else if (xg >= 3.2) score += 15;
    else if (xg >= 2.8) score += 5;
    else if (xg <  2.4) score -= 20;
  }

  const mov = (typeof p.mov35Over === 'number' && !isNaN(p.mov35Over)) ? p.mov35Over : 0;
  if (Math.abs(mov) < 1.5)          score += 10;
  else if (mov > 1.5 && mov < 4.0)  score += 5;
  else if (mov > 4.0)               score -= 15;

  if (typeof p.deltaLineaPrincipal === 'number') {
    if (p.deltaLineaPrincipal >= 0.5)       score += 10;
    else if (p.deltaLineaPrincipal <= -0.5) score -= 5;
  }

  if (typeof p.pinVentaja5m === 'number') {
    if (p.pinVentaja5m > 0.15)        score += 8;
    else if (p.pinVentaja5m < -0.15)  score -= 5;
  }

  if (p.casas35 >= 10)      score += 5;
  else if (p.casas35 < 3)   score -= 10;

  return Math.max(0, Math.min(100, score));
}

// ==================================================================
// SELECCIÓN Y COLA
// ==================================================================

function crearRegistroPartido(evento, diaLocal, etiqueta) {
  return {
    id: evento.id, sportKey: evento.sportKey, homeTeam: evento.home_team, awayTeam: evento.away_team,
    commenceTime: evento.commence_time, diaLocal, etiqueta, cuotas: {},
    estado: 'en_cola',
    nivelPeaje: null,
    prediccionEnviada: false, prediccion: null, scoreOver: null, mensajeMarcadorId: null
  };
}

function enVentanaHoraria(fechaIso) {
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: ZONA_HORARIA, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const parts = formatter.formatToParts(new Date(fechaIso));
  const min = parseInt(parts.find(p => p.type === 'hour').value) * 60 + parseInt(parts.find(p => p.type === 'minute').value);
  return min >= VENTANA_INICIO_MIN && min <= VENTANA_FIN_MIN;
}

function obtenerDiaLocal(fechaIso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_HORARIA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(fechaIso));
}

async function buscarYProgramarPartidos() {
  const ahora = Date.now();
  let todosLosEventos = [];
  for (const liga of LIGAS_PERMITIDAS) todosLosEventos = todosLosEventos.concat(await obtenerEventosLiga(liga));

  todosLosEventos = todosLosEventos.filter((e) => new Date(e.commence_time).getTime() > ahora && enVentanaHoraria(e.commence_time))
    .sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));

  if (todosLosEventos.length === 0) return { ok: false, mensaje: 'Sin partidos próximos en horario permitido.' };

  const antes = todosLosEventos.length;
  todosLosEventos = todosLosEventos.filter(e => ligaEsElegible(e.sportKey));
  const descartadosPorPriors = antes - todosLosEventos.length;
  if (descartadosPorPriors > 0) console.log(`🚫 ${descartadosPorPriors} descartados por priors`);

  const candidatosA = todosLosEventos.filter((e) => new Date(e.commence_time).getTime() - ahora >= 24 * 3600000);
  if (candidatosA.length === 0) return { ok: false, mensaje: 'No hay partidos a más de 24h.' };

  const candidatosPorLiga = {};
  for (const ev of candidatosA) {
    if (!candidatosPorLiga[ev.sportKey]) candidatosPorLiga[ev.sportKey] = [];
    candidatosPorLiga[ev.sportKey].push(ev);
  }

  const prefiltro = {};
  let ligasEscaneadas = 0;
  for (const [liga, candidatos] of Object.entries(candidatosPorLiga)) {
    if (candidatos.length >= PREFILTRO_BULK_MIN_CANDIDATOS) {
      const resumen = await preEscanearLiga(liga);
      Object.assign(prefiltro, resumen);
      ligasEscaneadas++;
      console.log(`🔍 Bulk scan ${liga}: ${Object.keys(resumen).length} partidos pre-filtrados`);
    }
  }

  const candidatosFiltrados = candidatosA.filter(ev => {
    const overEstimado = prefiltro[ev.id];
    if (overEstimado === undefined) return true;
    if (overEstimado === null) return true;
    return overEstimado < PREFILTRO_BULK_CUOTA_MAX;
  });

  const descartadosPorBulk = candidatosA.length - candidatosFiltrados.length;
  if (descartadosPorBulk > 0) console.log(`🚫 ${descartadosPorBulk} descartados por bulk pre-scan`);

  if (candidatosFiltrados.length === 0) {
    return { ok: false, mensaje: 'Ningún partido pasó los filtros de priors/bulk.' };
  }

  const anclaDelDia = candidatosFiltrados[0];
  const diaSeleccionado = obtenerDiaLocal(anclaDelDia.commence_time);

  return conBloqueoDB(async () => {
    const db = leerDB();

    const { eliminados } = await limpiarPartidosObsoletos(db);
    if (eliminados > 0) console.log(`🧹 Cleanup en búsqueda: ${eliminados} eliminados`);

    if (Object.values(db.partidos).some((p) => p.diaLocal === diaSeleccionado && p.estado !== 'cerrado' && p.estado !== 'abortado')) {
      return { bloqueado: true, mensaje: `Ya hay partidos en gestión para el ${diaSeleccionado}.` };
    }

    const mesActual = obtenerDiaLocal(new Date().toISOString()).slice(0, 7);
    if (!db.contadorMes || db.contadorMes.mes !== mesActual) db.contadorMes = { mes: mesActual, activos: 0 };
    if (db.contadorMes.activos >= OBJETIVO_MENSUAL_ACTIVOS) return { bloqueado: true, mensaje: `Límite de ${OBJETIVO_MENSUAL_ACTIVOS} partidos ACTIVOS alcanzado.` };

    const eventosDelDia = candidatosFiltrados.filter(e => obtenerDiaLocal(e.commence_time) === diaSeleccionado && new Date(e.commence_time).getTime() >= new Date(anclaDelDia.commence_time).getTime());
    db.calendarioDia = eventosDelDia;

    const seleccionados = [anclaDelDia];
    let ultimoTiempo = new Date(anclaDelDia.commence_time).getTime();
    for (const ev of eventosDelDia) {
      if (ev.id === anclaDelDia.id) continue;
      const t = new Date(ev.commence_time).getTime();
      if (t - ultimoTiempo >= GAP_MINIMO_MS) { seleccionados.push(ev); ultimoTiempo = t; }
    }

    seleccionados.forEach((ev, i) => {
      const p = crearRegistroPartido(ev, diaSeleccionado, `P${i + 1}`);
      db.partidos[ev.id] = p;
      programarChequeoPeaje(ev.id, p);
    });

    guardarDB(db);
    const stats = `Priors: -${descartadosPorPriors}, Bulk: -${descartadosPorBulk}, ${ligasEscaneadas} ligas escaneadas`;
    await enviarTelegram(`✅ ${seleccionados.length} partido(s) en cola.\n${stats}`);
    return { ok: true, mensaje: `${seleccionados.length} en cola. ${stats}` };
  });
}

// v4.9 Fix 1: delay de 5s si el peaje ya pasó (evita race condition con guardarDB)
function programarChequeoPeaje(matchId, partido) {
  const tiempoInicio = new Date(partido.commenceTime).getTime();
  const ejecucion24h = new Date(tiempoInicio - CHECKPOINTS[0].ms);

  if (ejecucion24h.getTime() <= Date.now() && tiempoInicio > Date.now()) {
    console.log(`⏰ Peaje 24h atrasado para ${partido.homeTeam} vs ${partido.awayTeam}, ejecutando en ${DELAY_PEAJE_ATRASADO_MS / 1000}s...`);
    setTimeout(() => {
      ejecutarChequeo(matchId, '24h', true);
    }, DELAY_PEAJE_ATRASADO_MS);
  } else if (ejecucion24h.getTime() > Date.now()) {
    trabajosActivos[`${matchId}_24h`] = schedule.scheduleJob(ejecucion24h, () => ejecutarChequeo(matchId, '24h', false));
  }
}

async function buscarReemplazo(diaLocal, tiempoLibreMs, db) {
  const candidatos = db.calendarioDia || [];
  const partidosVivos = Object.values(db.partidos).filter(p => p.estado === 'activo' || p.estado === 'en_cola');

  for (const ev of candidatos) {
    if (db.partidos[ev.id]) continue;
    const t = new Date(ev.commence_time).getTime();
    if (t < tiempoLibreMs) continue;
    if (t - Date.now() < VENTANA_REEMPLAZO_MS) continue;
    const solapa = partidosVivos.some(pv => Math.abs(t - new Date(pv.commenceTime).getTime()) < GAP_MINIMO_MS);
    if (!solapa) return ev;
  }
  return null;
}

// ==================================================================
// CHEQUEOS
// ==================================================================

async function ejecutarChequeo(matchId, cpClave, recuperadoTarde) {
  const pInicial = leerDB().partidos[matchId];
  if (!pInicial || pInicial.estado === 'abortado' || pInicial.estado === 'cerrado') return;

  let datos = null;
  let ultimoError = null;
  for (let i = 1; i <= INTENTOS_API_MAX; i++) {
    datos = await obtenerCuotasTotales(pInicial.sportKey, pInicial.id, cpClave);
    if (datos) break;
    ultimoError = `intento ${i}/${INTENTOS_API_MAX} falló`;
    if (i < INTENTOS_API_MAX) await new Promise(r => setTimeout(r, ESPERA_REINTENTO_MS));
  }

  if (!datos) {
    console.warn(`⚠️ ${cpClave} falló ${INTENTOS_API_MAX}x para ${pInicial.homeTeam} vs ${pInicial.awayTeam}`);
    await conBloqueoDB(async () => {
      const db = leerDB();
      const p = db.partidos[matchId];
      if (!p || p.estado === 'abortado' || p.estado === 'cerrado') return;

      if (cpClave === '24h') {
        p.estado = 'abortado';
        p.nivelPeaje = 'DESCARTE';
        p.motivoAborto = `api_fallo_${INTENTOS_API_MAX}intentos`;
        limpiarJobsPartido(matchId);
        await enviarTelegram(`❌ ${p.homeTeam} vs ${p.awayTeam}\nAPI falló ${INTENTOS_API_MAX} veces. Partido abortado.`);
      } else {
        p.motivoDecision = `api_fallo_${cpClave}`;
      }
      guardarDB(db);
    });
    return;
  }

  enviarASheets({
    tipo: 'chequeo', fechaCaptura: new Date().toISOString(),
    partidoId: pInicial.id, partido: `${pInicial.homeTeam} vs ${pInicial.awayTeam}`,
    chequeo: cpClave, horaInicioApi: datos.horaInicioApi,
    creditosRestantes: datos.creditosRestantes, cantidadCasas: datos.cantidadCasas
  }).catch(() => {});

  if (datos.filasCrudas.length > 0) {
    enviarASheets({ tipo: 'crudo', filasCrudas: datos.filasCrudas }).catch(() => {});
  }

  await conBloqueoDB(async () => {
    const db = leerDB();
    const p = db.partidos[matchId];
    if (!p || p.estado === 'abortado') return;

    p.cuotas[cpClave] = {
      lineas: datos.lineas, pinnacle35: datos.pinnacle35,
      casas35: datos.cantidadCasas, horaInicioReal: datos.horaInicioApi,
      recuperadoTarde
    };

    if (cpClave === '24h') {
      const over24h = p.cuotas['24h'].lineas[LINEA_PRINCIPAL]?.over;
      const xg24h = calcularXGPoisson(p.cuotas['24h'].lineas);
      const casas24h = datos.cantidadCasas;

      const esDescarte =
        !over24h ||
        over24h >= UMBRAL_ABORTO_CUOTA ||
        (typeof xg24h === 'number' && xg24h < UMBRAL_XG_24H_MIN) ||
        casas24h < UMBRAL_CASAS_MIN;

      if (esDescarte) {
        p.estado = 'abortado';
        p.nivelPeaje = 'DESCARTE';
        limpiarJobsPartido(matchId);
        const motivo = !over24h ? 'sin cuota' :
                       over24h >= UMBRAL_ABORTO_CUOTA ? `cuota ${over24h}` :
                       (typeof xg24h === 'number' && xg24h < UMBRAL_XG_24H_MIN) ? `xG ${xg24h}` :
                       `casas ${casas24h}`;
        p.motivoAborto = motivo;
        await enviarTelegram(`🛑 Descartado (${motivo})\n⚽ ${p.homeTeam} vs ${p.awayTeam}\nBuscando reemplazo...`);

        // v4.9 Fix 2: el reemplazo debe empezar al menos 30 min después de "ahora"
        // y en o después del partido original (para que su peaje 24h corra en el futuro)
        const tiempoHueco = Math.max(
          Date.now() + MARGEN_PEAJE_REEMPLAZO_MS,
          new Date(p.commenceTime).getTime()
        );
        const nuevoEv = await buscarReemplazo(p.diaLocal, tiempoHueco, db);
        if (nuevoEv) {
          const numActuales = Object.keys(db.partidos).length;
          const nuevoP = crearRegistroPartido(nuevoEv, p.diaLocal, `R${numActuales}`);
          db.partidos[nuevoEv.id] = nuevoP;
          programarChequeoPeaje(nuevoEv.id, nuevoP);
          await enviarTelegram(`✅ Reemplazo: ${nuevoP.homeTeam} vs ${nuevoP.awayTeam}`);
        } else {
          await enviarTelegram(`⚠️ Sin reemplazo disponible.`);
        }
      } else {
        const esPrometedor =
          over24h < UMBRAL_PROMETEDOR_CUOTA &&
          (typeof xg24h === 'number' && xg24h >= 3.20) &&
          casas24h >= UMBRAL_CASAS_PEAJE;

        p.estado = 'activo';
        p.nivelPeaje = esPrometedor ? 'PROMETEDOR' : 'CANDIDATO';
        db.contadorMes.activos += 1;

        const emoji = esPrometedor ? '🌟' : '🟢';
        const xgTxt = typeof xg24h === 'number' ? xg24h : 'N/A';
        await enviarTelegram(`${emoji} ${p.nivelPeaje} (cuota ${over24h}, xG ${xgTxt}, casas ${casas24h})\n⚽ ${p.homeTeam} vs ${p.awayTeam}`);

        const tiempoInicio = new Date(p.commenceTime).getTime();
        ['1h', '5m'].forEach(cpFuturo => {
          const msCp = CHECKPOINTS.find(c => c.clave === cpFuturo).ms;
          const msEjec = tiempoInicio - msCp;
          if (msEjec > Date.now()) {
            trabajosActivos[`${matchId}_${cpFuturo}`] = schedule.scheduleJob(new Date(msEjec), () => ejecutarChequeo(matchId, cpFuturo, false));
          }
        });
      }
    }
    guardarDB(db);
  });

  if (cpClave === '5m' && pInicial.estado === 'activo') await ejecutarPrediccion(matchId);
}

function analizarSerie(valores) {
  const delta = valores[valores.length - 1] - valores[0];
  let sos = Math.sign(delta) !== 0;
  for (let i = 1; i < valores.length; i++) {
    if (Math.sign(valores[i] - valores[i-1]) !== 0 && Math.sign(valores[i] - valores[i-1]) !== Math.sign(delta)) sos = false;
  }
  return { delta, sos };
}

async function ejecutarPrediccion(matchId) {
  return conBloqueoDB(async () => {
    const db = leerDB();
    const p = db.partidos[matchId];
    if (!p || p.estado !== 'activo') return;

    const clavesDisp = CHECKPOINTS.map(c => c.clave).filter(c => p.cuotas[c]?.lineas?.[LINEA_PRINCIPAL]);
    const datosMinimos = clavesDisp.includes('24h') && clavesDisp.includes('5m');

    let prediccion = null;
    let motivo = 'sin_datos_minimos';

    if (datosMinimos) {
      const ap = p.cuotas['24h'];
      const ci = p.cuotas['5m'];

      p.horaInicioReal = ci.horaInicioReal || ap.horaInicioReal;
      p.casas35 = ci.casas35 || ap.casas35 || 0;
      p.pinnacleOverApertura = ap.pinnacle35?.over;
      p.pinnacleOverCierre = ci.pinnacle35?.over;
      p.xgApertura = calcularXGPoisson(ap.lineas);
      p.xgCierre = calcularXGPoisson(ci.lineas);

      p.lineaPrincipal24h = lineaPrincipal(ap.lineas);
      p.lineaPrincipal5m = lineaPrincipal(ci.lineas);
      if (p.lineaPrincipal24h !== null && p.lineaPrincipal5m !== null) {
        p.deltaLineaPrincipal = Number((p.lineaPrincipal5m - p.lineaPrincipal24h).toFixed(2));
      } else {
        p.deltaLineaPrincipal = '';
      }

      const consensoOver24 = ap.lineas[LINEA_PRINCIPAL]?.over;
      const consensoOver5m = ci.lineas[LINEA_PRINCIPAL]?.over;
      p.pinVentaja24h = (consensoOver24 && ap.pinnacle35?.over) ? Number((consensoOver24 - ap.pinnacle35.over).toFixed(2)) : '';
      p.pinVentaja5m = (consensoOver5m && ci.pinnacle35?.over) ? Number((consensoOver5m - ci.pinnacle35.over).toFixed(2)) : '';

      p.recuperadoTarde = ap.recuperadoTarde || false;
      p.puntosUsados = `${clavesDisp.length}/3`;

      p.cuotaOverApertura = ap.lineas[LINEA_PRINCIPAL].over;
      p.cuotaUnderApertura = ap.lineas[LINEA_PRINCIPAL].under;
      p.cuotaOverCierre = ci.lineas[LINEA_PRINCIPAL].over;
      p.cuotaUnderCierre = ci.lineas[LINEA_PRINCIPAL].under;

      let senalPonderada = 0;
      let sumaPesos = 0;

      for (const line of LINEAS_A_RASTREAR) {
        const lStr = String(line);
        if (!clavesDisp.every(c => p.cuotas[c].lineas[lStr])) continue;
        const sOver = clavesDisp.map(c => (1 / p.cuotas[c].lineas[lStr].over) * 100);
        const aOver = analizarSerie(sOver);
        const suf = lStr.replace('.', '');
        p[`mov${suf}Over`] = Number(aOver.delta.toFixed(1));
        p[`sost${suf}Over`] = aOver.sos;
        const peso = 1 - Math.abs(sOver[0] - 50) / 50;
        senalPonderada += peso * aOver.delta;
        sumaPesos += peso;
      }
      p.senalPonderada = sumaPesos > 0 ? Number((senalPonderada / sumaPesos).toFixed(2)) : 0;

      p.scoreOver = scoreOver(p);

      const aperturaMala = p.cuotaOverApertura >= UMBRAL_ABORTO_CUOTA;
      const xgContradice = typeof p.xgCierre === 'number' && p.xgCierre < UMBRAL_XG_CONTRADICE;
      const puntosInsuficientes = clavesDisp.length < 2;
      const scoreSuficiente = p.scoreOver >= UMBRAL_SCORE_OVER;

      if (aperturaMala) motivo = 'apertura_mala';
      else if (xgContradice) motivo = 'xg_contradice';
      else if (puntosInsuficientes) motivo = 'puntos_insuficientes';
      else if (!scoreSuficiente) motivo = `score_${p.scoreOver}`;
      else motivo = 'ok';

      prediccion = (motivo === 'ok') ? 'OVER' : null;
      p.prediccion = prediccion;

      const emoji = prediccion === 'OVER' ? '🎯' : '⏸️';
      const predTxt = prediccion === 'OVER' ? 'OVER 3.5' : 'SIN APUESTA';
      await enviarTelegram(`${emoji} ${predTxt} en ${p.homeTeam} vs ${p.awayTeam}\nScore: ${p.scoreOver}/100 (${motivo})`);
    }

    p.prediccionEnviada = true;
    p.motivoDecision = motivo;
    db.partidos[matchId] = p;
    guardarDB(db);

    if (prediccion === 'OVER') {
      const ts = new Date(new Date(p.commenceTime).getTime() + 3 * 3600000);
      trabajosActivos[`${matchId}_marcador`] = schedule.scheduleJob(ts, () => enviarSolicitudMarcador(matchId));
    }
  });
}

// ==================================================================
// HISTORIAL
// ==================================================================

async function cerrarPartidoEnHistorial(p, marcador, statsExtra = {}) {
  let golesTotales = '';
  let acierto = null;

  if (marcador) {
    const match = marcador.match(/(\d+)\s*[-:xX]\s*(\d+)/);
    if (match) {
      golesTotales = parseInt(match[1]) + parseInt(match[2]);
      if (p.prediccion === 'OVER') acierto = golesTotales > 3.5;
    }
  }

  const cuota24h = p.cuotas?.['24h']?.lineas?.[LINEA_PRINCIPAL];
  const cuotaOverApertura = (typeof p.cuotaOverApertura === 'number' && !isNaN(p.cuotaOverApertura))
    ? p.cuotaOverApertura
    : (cuota24h?.over ?? undefined);
  const cuotaUnderApertura = (typeof p.cuotaUnderApertura === 'number' && !isNaN(p.cuotaUnderApertura))
    ? p.cuotaUnderApertura
    : (cuota24h?.under ?? undefined);
  const casas35 = (typeof p.casas35 === 'number' && !isNaN(p.casas35))
    ? p.casas35
    : (p.cuotas?.['24h']?.casas35 ?? undefined);
  const pinnacleOverApertura = (typeof p.pinnacleOverApertura === 'number' && !isNaN(p.pinnacleOverApertura))
    ? p.pinnacleOverApertura
    : (p.cuotas?.['24h']?.pinnacle35?.over ?? undefined);
  const xgApertura = (typeof p.xgApertura === 'number' && !isNaN(p.xgApertura))
    ? p.xgApertura
    : (p.cuotas?.['24h']?.lineas ? calcularXGPoisson(p.cuotas['24h'].lineas) : undefined);

  return await enviarASheets({
    fecha: new Date().toISOString(),
    horaInicioReal: p.horaInicioReal || p.commenceTime,
    liga: p.sportKey,
    equipoLocal: p.homeTeam,
    equipoVisitante: p.awayTeam,
    partido: `${p.homeTeam} vs ${p.awayTeam}`,
    linea: LINEA_PRINCIPAL,
    prediccion: p.prediccion || (p.estado === 'abortado' ? 'ABORTADO' : 'SIN_APUESTA'),
    golesTotales: golesTotales !== '' ? golesTotales : undefined,
    marcador: marcador || '',
    acierto,
    puntosUsados: p.puntosUsados,
    senalPonderada: p.senalPonderada,
    versionRegla: VERSION_REGLA,
    casas35,
    pinnacleOverApertura,
    pinnacleOverCierre: p.pinnacleOverCierre,
    xgApertura,
    xgCierre: p.xgCierre,
    recuperadoTarde: p.recuperadoTarde,
    lineaPrincipal24h: p.lineaPrincipal24h,
    lineaPrincipal5m: p.lineaPrincipal5m,
    deltaLineaPrincipal: p.deltaLineaPrincipal,
    pinVentaja24h: p.pinVentaja24h,
    pinVentaja5m: p.pinVentaja5m,
    scoreOver: p.scoreOver,
    nivelPeaje: p.nivelPeaje,
    motivoDecision: p.motivoDecision || p.motivoAborto || '',
    mov15Over: p.mov15Over, sost15Over: p.sost15Over,
    mov25Over: p.mov25Over, sost25Over: p.sost25Over,
    mov35Over: p.mov35Over, sost35Over: p.sost35Over,
    mov45Over: p.mov45Over, sost45Over: p.sost45Over,
    cuotaOverApertura,
    cuotaOverCierre: p.cuotaOverCierre,
    cuotaUnderApertura,
    cuotaUnderCierre: p.cuotaUnderCierre,
    xgHomePost: statsExtra?.xgHomePost,
    xgAwayPost: statsExtra?.xgAwayPost,
    bigChancesHome: statsExtra?.bigChancesHome,
    bigChancesAway: statsExtra?.bigChancesAway,
    shotsOnTargetHome: statsExtra?.shotsOnTargetHome,
    shotsOnTargetAway: statsExtra?.shotsOnTargetAway,
    redCardsHome: statsExtra?.redCardsHome,
    redCardsAway: statsExtra?.redCardsAway,
    minutoRojaHome: statsExtra?.minutoRojaHome,
    minutoRojaAway: statsExtra?.minutoRojaAway,
  });
}

async function enviarSolicitudMarcador(matchId) {
  return conBloqueoDB(async () => {
    const db = leerDB();
    const p = db.partidos[matchId];
    if (!p || p.mensajeMarcadorId || p.estado !== 'activo' || p.prediccion !== 'OVER') return;
    const msgId = await enviarTelegram(`⚽ ¿Marcador final de ${p.homeTeam} vs ${p.awayTeam}? Respondé (ej: 2-1). También podés esperar el auto-registro de FotMob (max 6h).`);
    if (msgId) { p.mensajeMarcadorId = msgId; guardarDB(db); }
  });
}

// ==================================================================
// WEBHOOK TELEGRAM
// ==================================================================

app.post('/api/telegram-webhook/:secret', async (req, res) => {
  if (req.params.secret !== TELEGRAM_WEBHOOK_SECRET) return res.sendStatus(403);
  const msg = req.body?.message;
  if (!msg?.text || String(msg.chat.id) !== String(TELEGRAM_CHAT_ID) || !msg.reply_to_message) return res.sendStatus(200);

  const respondeA = msg.reply_to_message.message_id;

  await conBloqueoDB(async () => {
    const db = leerDB();
    const matchId = Object.keys(db.partidos).find(id => db.partidos[id].mensajeMarcadorId === respondeA);
    if (!matchId) return;

    const p = db.partidos[matchId];
    const regex = msg.text.match(/(\d+)\s*[-:xX]\s*(\d+)/);
    if (!regex) { await enviarTelegram('Formato inválido. Respondé "2-1".'); return; }

    const mFinal = `${regex[1]}-${regex[2]}`;
    const goles = parseInt(regex[1]) + parseInt(regex[2]);

    let statsExtra = {};
    if (FOTMOB_ENABLED) {
      try {
        const cacheFechas = {};
        const resultado = await buscarPartidoEnFotMob(p, cacheFechas);
        if (resultado) {
          const stats = await obtenerStatsPost(resultado.id);
          if (stats) statsExtra = stats;
        }
      } catch (err) {
        console.warn(`⚠️ Stats post en webhook falló: ${err.message}`);
      }
    }

    const exito = await cerrarPartidoEnHistorial(p, mFinal, statsExtra);

    if (exito) {
      const result = goles > 3.5 ? '🎉 ¡Acertaste!' : '❌ Fallo.';
      const statsTxt = statsExtra.xgHomePost != null
        ? `\n📊 xG: ${statsExtra.xgHomePost}-${statsExtra.xgAwayPost}`
        : '';
      await enviarTelegram(`✅ Registrado: ${mFinal} (${goles} goles). ${result}${statsTxt}`);
      p.estado = 'cerrado';
      limpiarJobsPartido(matchId);
      delete db.partidos[matchId];
      guardarDB(db);
    }
  });

  res.sendStatus(200);
});

// ==================================================================
// RUTAS
// ==================================================================

app.get('/api/estado', (req, res) => {
  const db = leerDB();
  const ahora = Date.now();
  const todos = Object.values(db.partidos).sort((a, b) => new Date(a.commenceTime) - new Date(b.commenceTime));
  const vivos = todos.filter(p => p.estado !== 'cerrado' && p.estado !== 'abortado');
  // Abortados cuyo partido empieza entre ahora y +36h (los operativamente relevantes)
  const abortadosHoy = todos.filter(p =>
    p.estado === 'abortado' &&
    new Date(p.commenceTime).getTime() > ahora &&
    new Date(p.commenceTime).getTime() < ahora + 36 * 3600000
  );
  res.json({ partidos: vivos, abortadosHoy });
});

app.get('/api/estadisticas', async (req, res) => {
  try {
    const fetchRes = await fetch(`${GOOGLE_SHEETS_WEBHOOK_URL}?secreto=${encodeURIComponent(GOOGLE_SHEETS_SECRETO)}`);
    const data = await fetchRes.json();
    res.json(data.stats || { total: 0, resueltos: 0, winrate: 0, rachaActual: 0, rachaMaxima: 0 });
  } catch (err) {
    res.json({ error: true });
  }
});

app.post('/api/priors/recargar', async (req, res) => {
  PRIORS = await cargarPriors();
  res.json({ ok: true, ligas: Object.keys(PRIORS?.porLiga || {}).length });
});

app.get('/api/priors', (req, res) => {
  res.json(PRIORS || { porLiga: {}, porEquipo: {} });
});

app.post('/api/limpiar-obsoletos', async (req, res) => {
  try {
    const result = await conBloqueoDB(async () => {
      const db = leerDB();
      const r = await limpiarPartidosObsoletos(db);
      if (r.eliminados > 0) guardarDB(db);
      return r;
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/autocompletar', async (req, res) => {
  try {
    const result = await autoCompletarMarcadores();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/backfill', async (req, res) => {
  try {
    const result = await backfillHistorial();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/buscar-partidos', async (req, res) => {
  try { res.json(await buscarYProgramarPartidos()); }
  catch (err) { res.status(500).json({ ok: false }); }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ==================================================================
// ARRANQUE
// ==================================================================

app.listen(PORT, async () => {
  console.log(`🚀 Servidor ${VERSION_REGLA} puerto ${PORT}`);
  console.log(`📡 FotMob ${FOTMOB_ENABLED ? 'habilitado' : 'deshabilitado'}`);

  PRIORS = await cargarPriors();
  await recuperarEstadoSiHaceFalta();

  // A2: procesar primero con FotMob, después limpiar
  if (FOTMOB_ENABLED) {
    console.log('📡 Procesando partidos pendientes con FotMob...');
    try {
      const r = await autoCompletarMarcadores();
      console.log(`📡 Auto-fill inicio: ${r.completados}/${r.candidatos} completados`);
    } catch (err) {
      console.error(`❌ Auto-fill inicio falló: ${err.message}`);
    }
  }

  await conBloqueoDB(async () => {
    const db = leerDB();
    const { eliminados, cerrados } = await limpiarPartidosObsoletos(db);
    if (eliminados > 0) {
      guardarDB(db);
      console.log(`🧹 Cleanup inicio: ${eliminados} eliminados, ${cerrados} cerrados en historial`);
    }
  });

  const db = leerDB();
  Object.entries(db.partidos).forEach(([id, p]) => {
    if (p.estado === 'en_cola') {
      if (p.cuotas['24h']) {
        ejecutarChequeo(id, '24h', true);
      } else {
        const msEjec24h = new Date(p.commenceTime).getTime() - CHECKPOINTS[0].ms;
        if (msEjec24h <= Date.now() && new Date(p.commenceTime).getTime() > Date.now()) {
          ejecutarChequeo(id, '24h', true);
        } else if (msEjec24h > Date.now()) {
          programarChequeoPeaje(id, p);
        }
      }
    } else if (p.estado === 'activo') {
      if (!p.prediccionEnviada) {
        ['1h', '5m'].forEach(cpFuturo => {
          const msEjec = new Date(p.commenceTime).getTime() - CHECKPOINTS.find(c => c.clave === cpFuturo).ms;
          if (msEjec > Date.now() && !p.cuotas[cpFuturo]) {
            trabajosActivos[`${id}_${cpFuturo}`] = schedule.scheduleJob(new Date(msEjec), () => ejecutarChequeo(id, cpFuturo, false));
          } else if (msEjec <= Date.now() && !p.cuotas[cpFuturo]) {
            ejecutarChequeo(id, cpFuturo, true);
          }
        });
      } else if (!p.mensajeMarcadorId && p.prediccion === 'OVER') {
        const t = new Date(new Date(p.commenceTime).getTime() + 3 * 3600000);
        trabajosActivos[`${id}_marcador`] = schedule.scheduleJob(t, () => enviarSolicitudMarcador(id));
      }
    }
  });

  const [h, m] = HORA_BUSQUEDA_DIARIA.split(':');
  const reglaBusqueda = new schedule.RecurrenceRule();
  reglaBusqueda.tz = ZONA_HORARIA; reglaBusqueda.hour = parseInt(h); reglaBusqueda.minute = parseInt(m);
  schedule.scheduleJob(reglaBusqueda, buscarYProgramarPartidos);

  if (FOTMOB_ENABLED) {
    const reglaFotMob = new schedule.RecurrenceRule();
    reglaFotMob.tz = ZONA_HORARIA;
    reglaFotMob.hour = FOTMOB_HORAS_CRON;
    reglaFotMob.minute = 15;
    schedule.scheduleJob(reglaFotMob, autoCompletarMarcadores);
    console.log(`⏰ FotMob cron: ${FOTMOB_HORAS_CRON.map(h => `${h}:15`).join(', ')} (${ZONA_HORARIA})`);

    const reglaBackfill = new schedule.RecurrenceRule();
    reglaBackfill.tz = ZONA_HORARIA;
    reglaBackfill.hour = [6, 18];
    reglaBackfill.minute = 0;
    schedule.scheduleJob(reglaBackfill, backfillHistorial);
    console.log(`⏰ Backfill cron: 06:00, 18:00 (${ZONA_HORARIA})`);
  }

  configurarWebhookTelegram();
});
