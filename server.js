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

const DB_PATH = path.join(__dirname, 'database.json');

// Ligas permitidas (claves de The-Odds-API)
const LIGAS_PERMITIDAS = [
  'soccer_epl',
  'soccer_efl_champ',
  'soccer_germany_bundesliga',
  'soccer_spain_la_liga',
  'soccer_italy_serie_a',
  'soccer_france_ligue_one',
  'soccer_netherlands_eredivisie',
  'soccer_portugal_primeira_liga',
  'soccer_brazil_campeonato',
  'soccer_mexico_ligamx',
  'soccer_usa_mls',
  'soccer_argentina_primera_division',
  'soccer_uefa_champs_league',
];

// Puntos de chequeo antes del inicio de cada partido (4 puntos, 8 créditos/partido)
const CHECKPOINTS = [
  { clave: '24h', ms: 24 * 60 * 60 * 1000 },
  { clave: '6h', ms: 6 * 60 * 60 * 1000 },
  { clave: '1h', ms: 1 * 60 * 60 * 1000 },
  { clave: '5m', ms: 5 * 60 * 1000 },
];

const LINEAS_A_RASTREAR = [1.5, 2.5, 3.5];
const LINEA_PRINCIPAL = '2.5';
const UMBRAL_MOVIMIENTO = 3; // puntos porcentuales de probabilidad implícita

const GAP_MINIMO_MS = 2.5 * 60 * 60 * 1000; // 2h30min entre partidos del mismo día
const MAX_PARTIDOS_NORMAL = 4;
const OBJETIVO_MENSUAL = 60; // meta de partidos analizados por mes

const HORA_BUSQUEDA_DIARIA = process.env.HORA_BUSQUEDA_DIARIA || '08:00';
const ZONA_HORARIA = process.env.ZONA_HORARIA || 'America/Lima';

let trabajosActivos = [];

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================================================================
// BASE DE DATOS (archivo JSON local, solo para partidos EN CURSO)
// ==================================================================

function leerDB() {
  if (!fs.existsSync(DB_PATH)) return { partidos: {} };
  try {
    const contenido = fs.readFileSync(DB_PATH, 'utf-8');
    const data = JSON.parse(contenido || '{}');
    if (!data.partidos) data.partidos = {};
    return data;
  } catch (err) {
    console.error('Error leyendo database.json:', err.message);
    return { partidos: {} };
  }
}

function guardarDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// ==================================================================
// TELEGRAM (enviar Y recibir)
// ==================================================================

// Devuelve el message_id del mensaje enviado (o null si falló), para
// poder more tarde detectar respuestas a ESE mensaje específico.
async function enviarTelegram(mensaje) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('Falta TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID en el archivo .env');
    return null;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: mensaje }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error('Error enviando mensaje a Telegram:', data.description);
      return null;
    }
    return data.result.message_id;
  } catch (err) {
    console.error('Error de red enviando a Telegram:', err.message);
    return null;
  }
}

// Registra la URL pública de Render como webhook de Telegram, para que
// nuestro bot pueda RECIBIR tus respuestas (no solo enviar). Solo
// funciona con una URL pública (Render la provee automáticamente vía
// RENDER_EXTERNAL_URL); en tu computadora esto no hace nada.
async function configurarWebhookTelegram() {
  if (!TELEGRAM_TOKEN) return;
  const urlPublica = process.env.RENDER_EXTERNAL_URL;
  if (!urlPublica) {
    console.log('ℹ️  Sin RENDER_EXTERNAL_URL (estás en local): el webhook de Telegram no se configura.');
    return;
  }
  const urlWebhook = `${urlPublica}/api/telegram-webhook/${TELEGRAM_WEBHOOK_SECRET}`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: urlWebhook }),
    });
    const data = await res.json();
    if (data.ok) {
      console.log(`✅ Webhook de Telegram configurado en ${urlWebhook}`);
    } else {
      console.error('No se pudo configurar el webhook de Telegram:', data.description);
    }
  } catch (err) {
    console.error('Error configurando webhook de Telegram:', err.message);
  }
}

// ==================================================================
// GOOGLE SHEETS (historial persistente)
// ==================================================================

async function guardarEnHistorial(entrada) {
  if (!GOOGLE_SHEETS_WEBHOOK_URL) {
    console.warn('GOOGLE_SHEETS_WEBHOOK_URL no configurado: no se guarda el historial.');
    return;
  }
  try {
    const res = await fetch(GOOGLE_SHEETS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secreto: GOOGLE_SHEETS_SECRETO, ...entrada }),
    });
    if (!res.ok) console.error('Error guardando en historial:', res.status);
  } catch (err) {
    console.error('Error de red guardando en historial (Google Sheets):', err.message);
  }
}

async function obtenerHistorial() {
  if (!GOOGLE_SHEETS_WEBHOOK_URL) return [];
  const url = `${GOOGLE_SHEETS_WEBHOOK_URL}?secreto=${encodeURIComponent(GOOGLE_SHEETS_SECRETO)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`El historial respondió ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Error desconocido leyendo el historial');
  return data.historial || [];
}

function calcularEstadisticas(historial) {
  const ordenado = [...historial].sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
  const conApuesta = ordenado.filter((h) => h.prediccion === 'OVER' || h.prediccion === 'UNDER');
  const esAcierto = (h) => h.acierto === true || h.acierto === 'SI';
  const aciertos = conApuesta.filter(esAcierto).length;
  const total = conApuesta.length;
  const porcentajeAciertos = total > 0 ? Number(((aciertos / total) * 100).toFixed(1)) : null;

  let racha = 0;
  let tipoRacha = null;
  for (let i = conApuesta.length - 1; i >= 0; i--) {
    const acerto = esAcierto(conApuesta[i]);
    if (tipoRacha === null) {
      tipoRacha = acerto ? 'acierto' : 'fallo';
      racha = 1;
    } else if ((tipoRacha === 'acierto') === acerto) {
      racha++;
    } else {
      break;
    }
  }

  return { totalAnalizados: ordenado.length, totalConApuesta: total, aciertos, porcentajeAciertos, racha, tipoRacha };
}

async function obtenerConteoMesActual() {
  try {
    const historial = await obtenerHistorial();
    const ahora = new Date();
    return historial.filter((h) => {
      const f = new Date(h.fecha);
      return f.getUTCMonth() === ahora.getUTCMonth() && f.getUTCFullYear() === ahora.getUTCFullYear();
    }).length;
  } catch (err) {
    console.error('No se pudo obtener el conteo mensual del historial:', err.message);
    return null;
  }
}

// "Modo recuperación": si vas atrasado respecto a la meta mensual de 60
// partidos, sube el máximo de partidos permitidos ese día para recuperar
// terreno. Si no se puede determinar el conteo (ej. Sheets caído), usa
// el máximo normal para no arriesgar nada.
async function calcularMaxPartidosHoy() {
  const analizados = await obtenerConteoMesActual();
  if (analizados === null) return MAX_PARTIDOS_NORMAL;

  const ahora = new Date();
  const diaDelMes = parseInt(
    new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_HORARIA, day: '2-digit' }).format(ahora),
    10
  );
  const diasEnElMes = new Date(ahora.getFullYear(), ahora.getMonth() + 1, 0).getDate();
  const ritmoEsperado = OBJETIVO_MENSUAL * (diaDelMes / diasEnElMes);
  const deficit = ritmoEsperado - analizados;

  if (deficit >= 6) return 6;
  if (deficit >= 3) return 5;
  return MAX_PARTIDOS_NORMAL;
}

// ==================================================================
// THE ODDS API
// ==================================================================

async function obtenerEventosLiga(sportKey) {
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/events?apiKey=${ODDS_API_KEY}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Error obteniendo eventos de ${sportKey}: ${res.status}`);
      return [];
    }
    const eventos = await res.json();
    return eventos.map((e) => ({ ...e, sportKey }));
  } catch (err) {
    console.error(`Error de red obteniendo eventos de ${sportKey}:`, err.message);
    return [];
  }
}

// Trae, en UNA sola llamada (2 créditos: alternate_totals + btts, 1 región),
// las 3 líneas de goles (1.5/2.5/3.5) Y el mercado BTTS de un partido.
async function obtenerCuotasTotales(sportKey, eventId) {
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${eventId}/odds?apiKey=${ODDS_API_KEY}&regions=eu&markets=alternate_totals,btts&oddsFormat=decimal`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Error obteniendo cuotas del evento ${eventId}: ${res.status}`);
      return null;
    }
    const data = await res.json();

    const acumuladorLineas = {};
    for (const p of LINEAS_A_RASTREAR) acumuladorLineas[String(p)] = { overs: [], unders: [] };
    const acumuladorBtts = { si: [], no: [] };

    for (const casa of data.bookmakers || []) {
      const mercadoTotals = casa.markets.find((m) => m.key === 'alternate_totals');
      if (mercadoTotals) {
        for (const outcome of mercadoTotals.outcomes) {
          if (!LINEAS_A_RASTREAR.includes(outcome.point)) continue;
          const clave = String(outcome.point);
          if (outcome.name === 'Over') acumuladorLineas[clave].overs.push(outcome.price);
          if (outcome.name === 'Under') acumuladorLineas[clave].unders.push(outcome.price);
        }
      }
      const mercadoBtts = casa.markets.find((m) => m.key === 'btts');
      if (mercadoBtts) {
        for (const outcome of mercadoBtts.outcomes) {
          if (outcome.name === 'Yes') acumuladorBtts.si.push(outcome.price);
          if (outcome.name === 'No') acumuladorBtts.no.push(outcome.price);
        }
      }
    }

    const promedio = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

    const lineas = {};
    for (const p of LINEAS_A_RASTREAR) {
      const clave = String(p);
      const { overs, unders } = acumuladorLineas[clave];
      lineas[clave] =
        overs.length && unders.length
          ? { over: Number(promedio(overs).toFixed(2)), under: Number(promedio(unders).toFixed(2)) }
          : null;
    }

    const btts =
      acumuladorBtts.si.length && acumuladorBtts.no.length
        ? { si: Number(promedio(acumuladorBtts.si).toFixed(2)), no: Number(promedio(acumuladorBtts.no).toFixed(2)) }
        : null;

    return { lineas, btts };
  } catch (err) {
    console.error(`Error de red obteniendo cuotas del evento ${eventId}:`, err.message);
    return null;
  }
}

// ==================================================================
// SELECCIÓN DE PARTIDOS
// ==================================================================

function crearRegistroPartido(evento, diaLocal, etiqueta) {
  return {
    id: evento.id,
    sportKey: evento.sportKey,
    homeTeam: evento.home_team,
    awayTeam: evento.away_team,
    commenceTime: evento.commence_time,
    diaLocal,
    etiqueta,
    cuotas: {},
    prediccionEnviada: false,
    prediccion: null, // 'OVER' | 'UNDER' | 'SIN_APUESTA'
    mensajeMarcadorId: null,
    estadoFinal: null, // null | 'esperando_marcador'
  };
}

function formatearFecha(iso) {
  return new Date(iso).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
}

function obtenerDiaLocal(fechaIso, zona) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(fechaIso)
  );
}

async function buscarYProgramarPartidos() {
  const ahora = Date.now();
  const VEINTICUATRO_HORAS = 24 * 60 * 60 * 1000;

  let todosLosEventos = [];
  for (const liga of LIGAS_PERMITIDAS) {
    const eventos = await obtenerEventosLiga(liga);
    todosLosEventos = todosLosEventos.concat(eventos);
  }

  todosLosEventos = todosLosEventos
    .filter((e) => new Date(e.commence_time).getTime() > ahora)
    .sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time));

  if (todosLosEventos.length === 0) {
    const msg = '⚠️ No se encontraron partidos próximos en las ligas permitidas.';
    await enviarTelegram(msg);
    return { ok: false, mensaje: msg };
  }

  const candidatosA = todosLosEventos.filter((e) => new Date(e.commence_time).getTime() - ahora >= VEINTICUATRO_HORAS);
  if (candidatosA.length === 0) {
    const msg = '⚠️ No se encontró ningún partido que inicie en 24h o más desde ahora.';
    await enviarTelegram(msg);
    return { ok: false, mensaje: msg };
  }

  const anclaDelDia = candidatosA[0];
  const diaSeleccionado = obtenerDiaLocal(anclaDelDia.commence_time, ZONA_HORARIA);

  const db = leerDB();

  // Limpieza: si un partido terminó y nunca contestaste el marcador
  // dentro de 48h, se da de baja (no queda esperando para siempre).
  Object.keys(db.partidos).forEach((id) => {
    const p = db.partidos[id];
    const horasDesdeInicio = (Date.now() - new Date(p.commenceTime).getTime()) / (60 * 60 * 1000);
    if (p.prediccionEnviada && horasDesdeInicio > 48) delete db.partidos[id];
  });

  // Solo bloquea una nueva búsqueda si hay partidos REALMENTE en curso
  // (todavía no mandaron su predicción) para ese día. Un partido que ya
  // mandó su predicción y solo está esperando que le contestes el
  // marcador NO bloquea la búsqueda de días siguientes.
  const yaHayEseDia = Object.values(db.partidos).some((p) => p.diaLocal === diaSeleccionado && !p.prediccionEnviada);
  if (yaHayEseDia) {
    const msg = `ℹ️ Ya hay partidos en curso programados para el ${diaSeleccionado}. No se buscan partidos nuevos hasta que esos terminen.`;
    console.log(msg);
    return { ok: false, mensaje: msg };
  }

  const maxPartidosHoy = await calcularMaxPartidosHoy();

  const eventosDelDia = todosLosEventos.filter(
    (e) =>
      obtenerDiaLocal(e.commence_time, ZONA_HORARIA) === diaSeleccionado &&
      new Date(e.commence_time).getTime() >= new Date(anclaDelDia.commence_time).getTime()
  );

  const seleccionados = [anclaDelDia];
  let ultimoTiempo = new Date(anclaDelDia.commence_time).getTime();
  for (const evento of eventosDelDia) {
    if (seleccionados.length >= maxPartidosHoy) break;
    if (evento.id === anclaDelDia.id) continue;
    const tiempoEvento = new Date(evento.commence_time).getTime();
    if (tiempoEvento - ultimoTiempo >= GAP_MINIMO_MS) {
      seleccionados.push(evento);
      ultimoTiempo = tiempoEvento;
    }
  }

  const LETRAS = ['A', 'B', 'C', 'D', 'E', 'F'];
  seleccionados.forEach((evento, i) => {
    const registro = crearRegistroPartido(evento, diaSeleccionado, LETRAS[i]);
    db.partidos[evento.id] = registro;
    programarChequeos(evento.id, registro);
  });
  guardarDB(db);

  const emojisLetra = { A: '🅰️', B: '🅱️', C: '🇨', D: '🇩', E: '🇪', F: '🇫' };
  const bloques = seleccionados.map(
    (evento, i) =>
      `${emojisLetra[LETRAS[i]]} ${evento.home_team} vs ${evento.away_team}\n🕒 ${formatearFecha(evento.commence_time)}`
  );
  const mensaje = `✅ ${seleccionados.length} partido(s) programado(s) para el ${diaSeleccionado}:\n\n${bloques.join('\n\n')}`;
  await enviarTelegram(mensaje);

  return { ok: true, mensaje: `${seleccionados.length} partido(s) programado(s) correctamente.`, db };
}

// ==================================================================
// PROGRAMACIÓN DE CHEQUEOS
// ==================================================================

function programarChequeos(matchId, partido) {
  const tiempoInicio = new Date(partido.commenceTime).getTime();
  for (const checkpoint of CHECKPOINTS) {
    if (partido.cuotas && partido.cuotas[checkpoint.clave]) continue;
    const momentoEjecucion = new Date(tiempoInicio - checkpoint.ms);
    if (momentoEjecucion.getTime() <= Date.now()) {
      console.log(`⏭️  Checkpoint ${checkpoint.clave} de ${matchId} ya pasó, se omite.`);
      continue;
    }
    const job = schedule.scheduleJob(momentoEjecucion, () => ejecutarChequeo(matchId, checkpoint.clave));
    trabajosActivos.push(job);
    console.log(
      `📅 Programado chequeo "${checkpoint.clave}" de ${partido.homeTeam} vs ${partido.awayTeam} para ${momentoEjecucion.toLocaleString('es-ES')}`
    );
  }
}

async function ejecutarChequeo(matchId, claveCheckpoint) {
  const db = leerDB();
  const partido = db.partidos[matchId];
  if (!partido) {
    console.log(`El partido ${matchId} ya no existe en la base de datos, se omite el chequeo.`);
    return;
  }

  console.log(`🔍 Chequeo "${claveCheckpoint}" para ${partido.homeTeam} vs ${partido.awayTeam}`);
  const resultado = await obtenerCuotasTotales(partido.sportKey, partido.id);

  if (!resultado) {
    console.log(`No se pudieron obtener cuotas para ${matchId} (${claveCheckpoint}).`);
  } else {
    partido.cuotas[claveCheckpoint] = { ...resultado, timestamp: new Date().toISOString() };
    db.partidos[matchId] = partido;
    guardarDB(db);
    console.log(`✔️ Cuotas guardadas (${claveCheckpoint}) para ${matchId}`);
  }

  if (claveCheckpoint === '5m') {
    await ejecutarPrediccion(matchId);
  }
}

// ==================================================================
// ALGORITMO DE PREDICCIÓN (tendencia sostenida, Over/Under + BTTS)
// ==================================================================

function calcularProbabilidadImplicita(cuotaDecimal) {
  return (1 / cuotaDecimal) * 100;
}

// Analiza una serie de 4 valores en el tiempo (24h,6h,1h,5m). "Sostenida"
// significa que ningún intervalo se movió en contra de la dirección
// general (se permite que quede plano, no que se revierta).
function analizarSerie(valores) {
  const deltaTotal = valores[valores.length - 1] - valores[0];
  const signoTotal = Math.sign(deltaTotal);
  let sostenida = signoTotal !== 0;
  for (let i = 1; i < valores.length; i++) {
    const d = valores[i] - valores[i - 1];
    if (Math.sign(d) !== 0 && Math.sign(d) !== signoTotal) {
      sostenida = false;
      break;
    }
  }
  return { deltaTotal, sostenida };
}

async function ejecutarPrediccion(matchId) {
  const db = leerDB();
  const partido = db.partidos[matchId];
  if (!partido) return;

  const nombrePartido = `${partido.homeTeam} vs ${partido.awayTeam}`;
  const claves = CHECKPOINTS.map((c) => c.clave); // ['24h','6h','1h','5m']
  const datosCompletos = claves.every(
    (c) => partido.cuotas[c] && partido.cuotas[c].lineas && partido.cuotas[c].lineas[LINEA_PRINCIPAL]
  );

  let mensaje;
  let prediccion = 'SIN_APUESTA';

  if (!datosCompletos) {
    mensaje = `⚠️ SIN APUESTA (Datos insuficientes) en: ${nombrePartido}`;
  } else {
    const serieOver = claves.map((c) => calcularProbabilidadImplicita(partido.cuotas[c].lineas[LINEA_PRINCIPAL].over));
    const serieUnder = claves.map((c) => calcularProbabilidadImplicita(partido.cuotas[c].lineas[LINEA_PRINCIPAL].under));
    const analisisOver = analizarSerie(serieOver);
    const analisisUnder = analizarSerie(serieUnder);

    let direccion = null;
    if (analisisOver.deltaTotal >= UMBRAL_MOVIMIENTO && analisisOver.sostenida) direccion = 'OVER';
    else if (analisisUnder.deltaTotal >= UMBRAL_MOVIMIENTO && analisisUnder.sostenida) direccion = 'UNDER';

    let confirmaBtts = false;
    let serieDireccion = null;
    if (direccion) {
      serieDireccion = direccion === 'OVER' ? serieOver : serieUnder;
      const bttsDisponible = claves.every((c) => partido.cuotas[c].btts);
      if (bttsDisponible) {
        const serieBttsSi = claves.map((c) => calcularProbabilidadImplicita(partido.cuotas[c].btts.si));
        const analisisBtts = analizarSerie(serieBttsSi);
        if (direccion === 'OVER') {
          confirmaBtts = analisisBtts.deltaTotal >= UMBRAL_MOVIMIENTO && analisisBtts.sostenida;
        } else {
          confirmaBtts = analisisBtts.deltaTotal <= -UMBRAL_MOVIMIENTO && analisisBtts.sostenida;
        }
      }
    }

    if (direccion && confirmaBtts) {
      prediccion = direccion;
      const emoji = direccion === 'OVER' ? '🚨 OVER 2.5 GOLES' : '🚨 UNDER 2.5 GOLES';
      const recorrido = claves.map((c, i) => `${c}: ${serieDireccion[i].toFixed(1)}%`).join(' → ');
      mensaje =
        `${emoji} - Tendencia Profesional en: ${nombrePartido}\n\n` +
        `Movimiento sostenido: ${recorrido}\n` +
        `Confirmado por BTTS.`;
    } else {
      mensaje = `⚠️ SIN APUESTA (Mercado Incierto) en: ${nombrePartido}`;
    }
  }

  await enviarTelegram(mensaje);
  partido.prediccionEnviada = true;
  partido.prediccion = prediccion;
  db.partidos[matchId] = partido;
  guardarDB(db);

  programarSolicitudMarcador(matchId, partido);
}

// ==================================================================
// SOLICITUD DE MARCADOR FINAL (100% manual, vía respuesta en Telegram)
// ==================================================================

function programarSolicitudMarcador(matchId, partido) {
  const tiempoSolicitud = new Date(new Date(partido.commenceTime).getTime() + 3 * 60 * 60 * 1000);
  if (tiempoSolicitud.getTime() <= Date.now()) {
    enviarSolicitudMarcador(matchId);
    return;
  }
  const job = schedule.scheduleJob(tiempoSolicitud, () => enviarSolicitudMarcador(matchId));
  trabajosActivos.push(job);
}

async function enviarSolicitudMarcador(matchId) {
  const db = leerDB();
  const partido = db.partidos[matchId];
  if (!partido || partido.mensajeMarcadorId) return;

  const mensajeId = await enviarTelegram(
    `⚽ ¿Cuál fue el marcador final de ${partido.homeTeam} vs ${partido.awayTeam}? Respondé a este mensaje con el resultado (ejemplo: 2-1).`
  );
  if (mensajeId) {
    partido.mensajeMarcadorId = mensajeId;
    partido.estadoFinal = 'esperando_marcador';
    db.partidos[matchId] = partido;
    guardarDB(db);
  }
}

// ==================================================================
// RESTAURAR PROGRAMACIÓN AL INICIAR
// ==================================================================

function restaurarProgramacionAlIniciar() {
  const db = leerDB();
  Object.entries(db.partidos).forEach(([matchId, partido]) => {
    if (!partido) return;
    if (!partido.prediccionEnviada) {
      if (new Date(partido.commenceTime).getTime() > Date.now()) {
        console.log(`♻️  Restaurando chequeos de ${partido.homeTeam} vs ${partido.awayTeam}`);
        programarChequeos(matchId, partido);
      }
      return;
    }
    if (!partido.mensajeMarcadorId) {
      programarSolicitudMarcador(matchId, partido);
    }
  });
}

// ==================================================================
// BÚSQUEDA AUTOMÁTICA DIARIA
// ==================================================================

function programarBusquedaDiaria() {
  const [horaStr, minutoStr] = HORA_BUSQUEDA_DIARIA.split(':');
  const regla = new schedule.RecurrenceRule();
  regla.tz = ZONA_HORARIA;
  regla.hour = parseInt(horaStr, 10);
  regla.minute = parseInt(minutoStr, 10);

  schedule.scheduleJob(regla, () => {
    console.log(`⏰ Ejecutando búsqueda automática diaria (${HORA_BUSQUEDA_DIARIA} ${ZONA_HORARIA})...`);
    buscarYProgramarPartidos();
  });
  console.log(`🗓️  Búsqueda automática programada todos los días a las ${HORA_BUSQUEDA_DIARIA} (${ZONA_HORARIA}).`);
}

// ==================================================================
// RUTAS
// ==================================================================

app.get('/api/estado', (req, res) => {
  const db = leerDB();
  const partidos = Object.values(db.partidos).sort((a, b) => new Date(a.commenceTime) - new Date(b.commenceTime));
  res.json({ partidos });
});

app.get('/api/estadisticas', async (req, res) => {
  try {
    const historial = await obtenerHistorial();
    res.json(calcularEstadisticas(historial));
  } catch (err) {
    console.error('Error en /api/estadisticas:', err.message);
    res.json({ totalAnalizados: 0, totalConApuesta: 0, aciertos: 0, porcentajeAciertos: null, racha: 0, tipoRacha: null, error: true });
  }
});

app.post('/api/buscar-partidos', async (req, res) => {
  try {
    const resultado = await buscarYProgramarPartidos();
    res.json(resultado);
  } catch (err) {
    console.error('Error en /api/buscar-partidos:', err);
    res.status(500).json({ ok: false, mensaje: 'Error interno del servidor.' });
  }
});

// Webhook de Telegram: acá llegan tus respuestas con el marcador.
app.post('/api/telegram-webhook/:secret', async (req, res) => {
  if (req.params.secret !== TELEGRAM_WEBHOOK_SECRET) return res.sendStatus(403);

  const mensaje = req.body && req.body.message;
  if (!mensaje || !mensaje.text) return res.sendStatus(200);
  if (String(mensaje.chat.id) !== String(TELEGRAM_CHAT_ID)) return res.sendStatus(200);

  const respondeAId = mensaje.reply_to_message && mensaje.reply_to_message.message_id;
  if (!respondeAId) return res.sendStatus(200);

  const db = leerDB();
  const matchId = Object.keys(db.partidos).find((id) => db.partidos[id].mensajeMarcadorId === respondeAId);
  if (!matchId) return res.sendStatus(200);

  const partido = db.partidos[matchId];
  const coincidencia = mensaje.text.match(/(\d+)\s*[-:xX]\s*(\d+)/);
  if (!coincidencia) {
    await enviarTelegram('No pude entender ese marcador. Respondé con el formato "2-1".');
    return res.sendStatus(200);
  }

  const golesLocal = parseInt(coincidencia[1], 10);
  const golesVisita = parseInt(coincidencia[2], 10);
  const golesTotales = golesLocal + golesVisita;

  let acierto = null;
  if (partido.prediccion === 'OVER') acierto = golesTotales > 2.5;
  else if (partido.prediccion === 'UNDER') acierto = golesTotales < 2.5;

  await guardarEnHistorial({
    fecha: new Date().toISOString(),
    liga: partido.sportKey,
    partido: `${partido.homeTeam} vs ${partido.awayTeam}`,
    linea: LINEA_PRINCIPAL,
    prediccion: partido.prediccion || 'SIN_APUESTA',
    golesTotales,
    marcador: `${golesLocal}-${golesVisita}`,
    acierto,
  });

  const resultadoTexto = acierto === true ? '🎉 ¡Acertaste!' : acierto === false ? '❌ No acertó.' : 'ℹ️ Registrado (no hubo apuesta).';
  await enviarTelegram(`✅ Marcador registrado: ${golesLocal}-${golesVisita} (${golesTotales} goles). ${resultadoTexto}`);

  delete db.partidos[matchId];
  guardarDB(db);

  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================================================================
// INICIO DEL SERVIDOR
// ==================================================================

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
  if (!ODDS_API_KEY) console.warn('⚠️  Falta THE_ODDS_API_KEY en el archivo .env');
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) console.warn('⚠️  Falta configuración de Telegram en el archivo .env');
  if (!GOOGLE_SHEETS_WEBHOOK_URL) console.warn('⚠️  Falta GOOGLE_SHEETS_WEBHOOK_URL: el historial no se va a guardar.');
  restaurarProgramacionAlIniciar();
  programarBusquedaDiaria();
  configurarWebhookTelegram();
});
