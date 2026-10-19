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

const LINEAS_A_RASTREAR = [1.5, 2.5, 3.5, 4.5];
const LINEA_PRINCIPAL = '3.5'; // cambiado de 2.5 a 3.5
const UMBRAL_MOVIMIENTO = 3; // puntos porcentuales de probabilidad implícita

const GAP_MINIMO_MS = 2.5 * 60 * 60 * 1000; // 2h30min entre partidos del mismo día
// Solo se consideran partidos que INICIEN entre las 6:00 y las 23:00 hora
// local (ZONA_HORARIA). Ya no hay tope de partidos por día: el límite es
// mensual (OBJETIVO_MENSUAL), para no pasarse de los créditos de la API.
const VENTANA_INICIO_MIN = 6 * 60;
const VENTANA_FIN_MIN = 23 * 60;
const OBJETIVO_MENSUAL = 120; // meta de partidos analizados por mes (subió al sacar BTTS: la mitad de créditos por partido)

const HORA_BUSQUEDA_DIARIA = process.env.HORA_BUSQUEDA_DIARIA || '05:00';
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
  // Además de guardar local, mandamos una copia a Google Sheets sin
  // esperar la respuesta (no debe frenar ni romper el resto del flujo
  // si falla). Esto es lo que permite recuperar los partidos "en curso"
  // si Render se reinicia y borra el disco local (pasa en cada
  // actualización de código, por ejemplo).
  sincronizarEstadoEnCurso(data).catch((err) => {
    console.error('No se pudo sincronizar el estado en curso con Sheets:', err.message);
  });
}

// Cola de operaciones sobre la base de datos. Si varios partidos tienen
// un chequeo programado casi a la misma hora (por ejemplo, el "24h
// antes" de 6 partidos distintos), cada uno lee, modifica y vuelve a
// guardar el archivo completo — sin esta cola, el que termina último
// pisa por completo lo que los demás acababan de guardar, y solo
// sobrevive uno. Con esto, cada lectura+escritura se hace de a una a la
// vez, nunca superpuestas.
let colaOperacionesDB = Promise.resolve();
function conBloqueoDB(tarea) {
  const resultado = colaOperacionesDB.then(tarea, tarea);
  colaOperacionesDB = resultado.then(
    () => {},
    () => {}
  );
  return resultado;
}

async function sincronizarEstadoEnCurso(data) {
  if (!GOOGLE_SHEETS_WEBHOOK_URL) return;
  await fetch(GOOGLE_SHEETS_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secreto: GOOGLE_SHEETS_SECRETO, tipo: 'estado', datos: JSON.stringify(data) }),
  });
}

async function recuperarEstadoEnCursoDeSheets() {
  if (!GOOGLE_SHEETS_WEBHOOK_URL) return null;
  try {
    const url = `${GOOGLE_SHEETS_WEBHOOK_URL}?secreto=${encodeURIComponent(GOOGLE_SHEETS_SECRETO)}&tipo=estado`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.ok || !data.estado) return null;
    const parseado = JSON.parse(data.estado);
    if (!parseado.partidos) parseado.partidos = {};
    return parseado;
  } catch (err) {
    console.error('No se pudo recuperar el estado en curso desde Sheets:', err.message);
    return null;
  }
}

// Al arrancar: si el disco local no tiene nada (por ejemplo, justo
// después de un redeploy en Render, que borra el disco), se intenta
// recuperar la última copia guardada en Sheets antes de restaurar la
// programación de chequeos. Así una actualización de código no hace
// perder los partidos que ya estaban en curso.
async function recuperarEstadoSiHaceFalta() {
  const dbLocal = leerDB();
  if (Object.keys(dbLocal.partidos).length > 0) return; // ya hay algo local, no hace falta recuperar nada

  console.log('🔄 No hay partidos en curso en el disco local (probablemente un redeploy). Buscando una copia en Sheets...');
  const dbRemota = await recuperarEstadoEnCursoDeSheets();
  if (dbRemota && Object.keys(dbRemota.partidos).length > 0) {
    fs.writeFileSync(DB_PATH, JSON.stringify(dbRemota, null, 2), 'utf-8'); // guardado local directo, sin volver a sincronizar
    console.log(`✅ Recuperados ${Object.keys(dbRemota.partidos).length} partido(s) en curso desde Sheets.`);
  } else {
    console.log('ℹ️ No había ninguna copia útil en Sheets (o Sheets no está configurado). Se arranca sin partidos en curso.');
  }
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
    return false;
  }
  try {
    const res = await fetch(GOOGLE_SHEETS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secreto: GOOGLE_SHEETS_SECRETO, ...entrada }),
    });
    if (!res.ok) {
      console.error('Error guardando en historial:', res.status);
      return false;
    }
    const data = await res.json();
    if (!data.ok) {
      console.error('El historial (Apps Script) respondió con error:', data.error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Error de red guardando en historial (Google Sheets):', err.message);
    return false;
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

// Trae, en UNA sola llamada (1 crédito: alternate_totals, 1 región), las
// 4 líneas de goles que rastreamos (1.5/2.5/3.5/4.5). BTTS se sacó por
// completo: no se pide, no se guarda, no influye en nada.
async function obtenerCuotasTotales(sportKey, eventId) {
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${eventId}/odds?apiKey=${ODDS_API_KEY}&regions=eu&markets=alternate_totals&oddsFormat=decimal`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Error obteniendo cuotas del evento ${eventId}: ${res.status}`);
      return null;
    }
    const data = await res.json();

    const acumuladorLineas = {};
    for (const p of LINEAS_A_RASTREAR) acumuladorLineas[String(p)] = { overs: [], unders: [] };

    for (const casa of data.bookmakers || []) {
      const mercadoTotals = casa.markets.find((m) => m.key === 'alternate_totals');
      if (!mercadoTotals) continue;
      for (const outcome of mercadoTotals.outcomes) {
        if (!LINEAS_A_RASTREAR.includes(outcome.point)) continue;
        const clave = String(outcome.point);
        if (outcome.name === 'Over') acumuladorLineas[clave].overs.push(outcome.price);
        if (outcome.name === 'Under') acumuladorLineas[clave].unders.push(outcome.price);
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

    return { lineas };
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

function minutosDelDiaLocal(fechaIso) {
  const partes = new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONA_HORARIA,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(fechaIso));
  const h = parseInt(partes.find((p) => p.type === 'hour').value, 10);
  const m = parseInt(partes.find((p) => p.type === 'minute').value, 10);
  return h * 60 + m;
}

function enVentanaHoraria(fechaIso) {
  const min = minutosDelDiaLocal(fechaIso);
  return min >= VENTANA_INICIO_MIN && min <= VENTANA_FIN_MIN;
}

function etiquetaDePartido(i) {
  return i < 26 ? String.fromCharCode(65 + i) : `P${i + 1}`;
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
    .filter((e) => enVentanaHoraria(e.commence_time))
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

  const resultadoBusqueda = await conBloqueoDB(async () => {
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
      return { bloqueado: true, mensaje: msg };
    }

    // Tope mensual (protege los créditos de la API). Cuenta los partidos
    // SELECCIONADOS en el mes, hayas contestado el marcador o no, porque
    // cada uno consume créditos igual.
    const mesActual = obtenerDiaLocal(new Date().toISOString(), ZONA_HORARIA).slice(0, 7);
    if (!db.contadorMes || db.contadorMes.mes !== mesActual) db.contadorMes = { mes: mesActual, seleccionados: 0 };
    const restantes = OBJETIVO_MENSUAL - db.contadorMes.seleccionados;
    if (restantes <= 0) {
      const msg = `ℹ️ Ya se programaron los ${OBJETIVO_MENSUAL} partidos de ${mesActual} (tope mensual para no pasarse de los créditos). Se retoma el mes que viene.`;
      console.log(msg);
      return { bloqueado: true, mensaje: msg };
    }

    const eventosDelDia = todosLosEventos.filter(
      (e) =>
        obtenerDiaLocal(e.commence_time, ZONA_HORARIA) === diaSeleccionado &&
        new Date(e.commence_time).getTime() >= new Date(anclaDelDia.commence_time).getTime()
    );

    const seleccionados = [anclaDelDia];
    let ultimoTiempo = new Date(anclaDelDia.commence_time).getTime();
    for (const evento of eventosDelDia) {
      if (seleccionados.length >= restantes) break;
      if (evento.id === anclaDelDia.id) continue;
      const tiempoEvento = new Date(evento.commence_time).getTime();
      if (tiempoEvento - ultimoTiempo >= GAP_MINIMO_MS) {
        seleccionados.push(evento);
        ultimoTiempo = tiempoEvento;
      }
    }

    seleccionados.forEach((evento, i) => {
      const registro = crearRegistroPartido(evento, diaSeleccionado, etiquetaDePartido(i));
      db.partidos[evento.id] = registro;
      programarChequeos(evento.id, registro);
    });
    db.contadorMes.seleccionados += seleccionados.length;
    guardarDB(db);

    return { bloqueado: false, seleccionados };
  });

  if (resultadoBusqueda.bloqueado) {
    return { ok: false, mensaje: resultadoBusqueda.mensaje };
  }

  const { seleccionados } = resultadoBusqueda;
  const emojisLetra = { A: '🅰️', B: '🅱️', C: '🇨', D: '🇩', E: '🇪', F: '🇫' };
  const bloques = seleccionados.map((evento, i) => {
    const letra = etiquetaDePartido(i);
    return `${emojisLetra[letra] || `▫️${letra}`} ${evento.home_team} vs ${evento.away_team}\n🕒 ${formatearFecha(evento.commence_time)}`;
  });
  const mensaje = `✅ ${seleccionados.length} partido(s) programado(s) para el ${diaSeleccionado}:\n\n${bloques.join('\n\n')}`;
  await enviarTelegram(mensaje);

  return { ok: true, mensaje: `${seleccionados.length} partido(s) programado(s) correctamente.` };
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
      if (tiempoInicio > Date.now()) {
        // El horario del chequeo ya pasó (probablemente el servidor estuvo
        // dormido/reiniciándose), pero el partido todavía no arrancó, así
        // que el dato sigue siendo útil: lo recuperamos ahora mismo en vez
        // de perderlo para siempre.
        console.log(`⏰ Checkpoint "${checkpoint.clave}" de ${partido.homeTeam} vs ${partido.awayTeam} atrasado, recuperando ahora.`);
        ejecutarChequeo(matchId, checkpoint.clave);
      } else {
        console.log(`⏭️  Checkpoint ${checkpoint.clave} de ${matchId} ya pasó y el partido ya empezó, se omite.`);
      }
      continue;
    }
    const job = schedule.scheduleJob(momentoEjecucion, () => ejecutarChequeo(matchId, checkpoint.clave));
    trabajosActivos.push(job);
    console.log(
      `📅 Programado chequeo "${checkpoint.clave}" de ${partido.homeTeam} vs ${partido.awayTeam} para ${momentoEjecucion.toLocaleString('es-ES')}`
    );
  }
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Reintenta hasta 3 veces (con 30s de espera entre intento y intento)
// antes de darse por vencido. Cubre errores puntuales: un hiccup de red,
// un timeout momentáneo de The-Odds-API, etc. — sin esto, un solo fallo
// pasajero hacía perder el chequeo completo, aunque el servidor estuviera
// funcionando bien.
async function obtenerCuotasConReintentos(sportKey, eventId, intentosRestantes = 3) {
  for (let intento = 1; intento <= intentosRestantes; intento++) {
    const resultado = await obtenerCuotasTotales(sportKey, eventId);
    if (resultado) return resultado;
    if (intento < intentosRestantes) {
      console.log(`↻ Cuotas no disponibles, reintentando (${intento + 1}/${intentosRestantes}) en 30s...`);
      await esperar(30000);
    }
  }
  return null;
}

async function ejecutarChequeo(matchId, claveCheckpoint) {
  const dbInicial = leerDB();
  const partidoInicial = dbInicial.partidos[matchId];
  if (!partidoInicial) {
    console.log(`El partido ${matchId} ya no existe en la base de datos, se omite el chequeo.`);
    return;
  }

  console.log(`🔍 Chequeo "${claveCheckpoint}" para ${partidoInicial.homeTeam} vs ${partidoInicial.awayTeam}`);
  const resultado = await obtenerCuotasConReintentos(partidoInicial.sportKey, partidoInicial.id);

  if (!resultado) {
    console.log(`No se pudieron obtener cuotas para ${matchId} (${claveCheckpoint}) después de reintentar.`);
  } else {
    // Recién ahora, con el dato ya en mano, tomamos turno en la cola:
    // leemos el estado más fresco posible y aplicamos el cambio, sin
    // pisar lo que otro partido haya guardado mientras esperábamos la API.
    await conBloqueoDB(() => {
      const db = leerDB();
      const partido = db.partidos[matchId];
      if (!partido) return; // pudo haberse dado de baja mientras se esperaba la API
      partido.cuotas[claveCheckpoint] = { ...resultado, timestamp: new Date().toISOString() };
      db.partidos[matchId] = partido;
      guardarDB(db);
    });
    console.log(`✔️ Cuotas guardadas (${claveCheckpoint}) para ${matchId}`);
  }

  if (claveCheckpoint === '5m') {
    await ejecutarPrediccion(matchId);
  }
}

// ==================================================================
// ALGORITMO DE PREDICCIÓN (tendencia sostenida, línea 3.5, sin BTTS)
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
  return conBloqueoDB(async () => {
  const db = leerDB();
  const partido = db.partidos[matchId];
  if (!partido) return;

  const nombrePartido = `${partido.homeTeam} vs ${partido.awayTeam}`;
  const claves = CHECKPOINTS.map((c) => c.clave); // ['24h','6h','1h','5m']
  const clavesDisponibles = claves.filter(
    (c) => partido.cuotas[c] && partido.cuotas[c].lineas && partido.cuotas[c].lineas[LINEA_PRINCIPAL]
  );
  const faltantes = claves.filter((c) => !clavesDisponibles.includes(c));
  // Mínimo indispensable: apertura (24h) y cierre (5m), son los extremos
  // que definen el movimiento. Un punto intermedio faltante (6h o 1h) no
  // debería tirar todo el análisis a la basura — se analiza con los
  // puntos que sí tenemos.
  const datosMinimos =
    clavesDisponibles.includes('24h') && clavesDisponibles.includes('5m') && clavesDisponibles.length >= 2;

  let mensaje;
  let prediccion = 'SIN_APUESTA';

  if (!datosMinimos) {
    mensaje =
      `⚠️ SIN APUESTA (Datos insuficientes) en: ${nombrePartido}\n\n` +
      `🎯 Elección forzada: no se pudo calcular (faltan los chequeos de apertura o cierre, no hay con qué comparar).`;
  } else {
    const notaFaltantes =
      faltantes.length > 0
        ? `\n(⚠️ faltó el chequeo de ${faltantes.join(', ')}; análisis con ${clavesDisponibles.length} de ${claves.length} puntos)`
        : '';

    const serieOver = clavesDisponibles.map((c) => calcularProbabilidadImplicita(partido.cuotas[c].lineas[LINEA_PRINCIPAL].over));
    const serieUnder = clavesDisponibles.map((c) => calcularProbabilidadImplicita(partido.cuotas[c].lineas[LINEA_PRINCIPAL].under));
    const analisisOver = analizarSerie(serieOver);
    const analisisUnder = analizarSerie(serieUnder);

    // Diagnóstico de la línea principal (3.5): se guarda SIEMPRE que haya
    // datos mínimos, dispare o no una predicción.
    partido.movimientoOver = Number(analisisOver.deltaTotal.toFixed(1));
    partido.sostenidaOver = analisisOver.sostenida;
    partido.movimientoUnder = Number(analisisUnder.deltaTotal.toFixed(1));
    partido.sostenidaUnder = analisisUnder.sostenida;
    partido.puntosUsados = `${clavesDisponibles.length}/${claves.length}`;

    // Cuotas de apertura (24h) y cierre (5m) de la línea principal, de
    // AMBOS lados, siempre. Sirven para medir calibración después.
    const lineaApertura = partido.cuotas['24h'].lineas[LINEA_PRINCIPAL];
    const lineaCierre = partido.cuotas['5m'].lineas[LINEA_PRINCIPAL];
    partido.cuotaOverApertura = lineaApertura.over;
    partido.cuotaOverCierre = lineaCierre.over;
    partido.cuotaUnderApertura = lineaApertura.under;
    partido.cuotaUnderCierre = lineaCierre.under;

    // Análisis individual de CADA línea rastreada (1.5/2.5/3.5/4.5), no
    // solo la principal. Se guarda siempre, sea cual sea el resultado, y
    // además alimenta la elección forzada de abajo.
    const analisisPorLinea = {}; // { '1.5': {over:{...}, under:{...}, probAperturaOver}, ... }
    for (const p of LINEAS_A_RASTREAR) {
      const clave = String(p);
      const disponibleEnTodos = clavesDisponibles.every((c) => partido.cuotas[c].lineas[clave]);
      if (!disponibleEnTodos) continue;

      const sOver = clavesDisponibles.map((c) => calcularProbabilidadImplicita(partido.cuotas[c].lineas[clave].over));
      const sUnder = clavesDisponibles.map((c) => calcularProbabilidadImplicita(partido.cuotas[c].lineas[clave].under));
      const aOver = analizarSerie(sOver);
      const aUnder = analizarSerie(sUnder);
      const sufijo = clave.replace('.', '');

      partido[`mov${sufijo}Over`] = Number(aOver.deltaTotal.toFixed(1));
      partido[`sost${sufijo}Over`] = aOver.sostenida;
      partido[`mov${sufijo}Under`] = Number(aUnder.deltaTotal.toFixed(1));
      partido[`sost${sufijo}Under`] = aUnder.sostenida;

      analisisPorLinea[clave] = { movimientoOver: aOver.deltaTotal, probAperturaOver: sOver[0] };
    }

    // Elección forzada en la línea principal (3.5), pero calculada con la
    // info de TODAS las líneas: el movimiento de cada línea se pondera
    // más fuerte cuanto más "pareja" (cerca del 50%) estaba esa línea al
    // abrir — una línea que ya abría muy decidida aporta poco.
    let sumaPonderada = 0;
    let sumaPesos = 0;
    for (const clave of Object.keys(analisisPorLinea)) {
      const { movimientoOver, probAperturaOver } = analisisPorLinea[clave];
      const peso = 1 - Math.abs(probAperturaOver - 50) / 50; // 1 = perfectamente parejo, 0 = casi decidido
      sumaPonderada += peso * movimientoOver;
      sumaPesos += peso;
    }
    partido.senalPonderada = sumaPesos > 0 ? Number((sumaPonderada / sumaPesos).toFixed(2)) : 0;
    partido.direccionForzada = partido.senalPonderada >= 0 ? 'OVER' : 'UNDER';

    let direccion = null;
    if (analisisOver.deltaTotal >= UMBRAL_MOVIMIENTO && analisisOver.sostenida) direccion = 'OVER';
    else if (analisisUnder.deltaTotal >= UMBRAL_MOVIMIENTO && analisisUnder.sostenida) direccion = 'UNDER';

    if (direccion) {
      prediccion = direccion;
      const serieDireccion = direccion === 'OVER' ? serieOver : serieUnder;
      const recorrido = clavesDisponibles.map((c, i) => `${c}: ${serieDireccion[i].toFixed(1)}%`).join(' → ');

      mensaje =
        `🧪 ${direccion} ${LINEA_PRINCIPAL} GOLES (EXPERIMENTAL) en: ${nombrePartido}\n\n` +
        `Movimiento sostenido: ${recorrido}\n` +
        `Señal sin validar todavía.\n` +
        `🎯 Elección forzada (registro, no es sugerencia): ${partido.direccionForzada}` +
        notaFaltantes;

    } else {
      mensaje =
        `⚠️ SIN APUESTA (Mercado Incierto) en: ${nombrePartido}\n\n` +
        `🎯 Elección forzada (registro, no es sugerencia): ${partido.direccionForzada}` +
        notaFaltantes;
    }
  }

  await enviarTelegram(mensaje);
  partido.prediccionEnviada = true;
  partido.prediccion = prediccion;
  db.partidos[matchId] = partido;
  guardarDB(db);

  programarSolicitudMarcador(matchId, partido);
  });
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
  return conBloqueoDB(async () => {
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
  });
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

// Ruta de prueba manual: visitá esta URL en el navegador para confirmar
// que la conexión con Google Sheets (guardar Y leer) funciona bien, sin
// tener que esperar a que termine un partido real. Protegida con el
// mismo secreto que usa el webhook de Telegram, para que no cualquiera
// la use. Es segura de dejar en el proyecto de forma permanente.
app.get('/api/test-historial/:secret', async (req, res) => {
  if (req.params.secret !== TELEGRAM_WEBHOOK_SECRET) return res.status(404).send('No encontrado');

  const guardado = await guardarEnHistorial({
    fecha: new Date().toISOString(),
    liga: 'prueba_conexion',
    partido: 'Equipo Prueba A vs Equipo Prueba B',
    linea: LINEA_PRINCIPAL,
    prediccion: 'OVER',
    golesTotales: 3,
    marcador: '2-1',
    acierto: true,
    cuotaOverApertura: 2.0,
    cuotaOverCierre: 1.81,
    puntosUsados: '4/4',
    movimientoOver: 5.2,
    sostenidaOver: true,
    movimientoUnder: -3.8,
    sostenidaUnder: true,
    cuotaUnderApertura: 1.85,
    cuotaUnderCierre: 2.05,
    direccionForzada: 'OVER',
    aciertoForzado: true,
    senalPonderada: 2.1,
    mov15Over: 1.1, sost15Over: true, mov15Under: -1.1, sost15Under: true,
    mov25Over: 3.4, sost25Over: true, mov25Under: -3.4, sost25Under: true,
    mov35Over: 5.2, sost35Over: true, mov35Under: -3.8, sost35Under: true,
    mov45Over: 2.0, sost45Over: false, mov45Under: -1.5, sost45Under: false,
  });

  if (!guardado) {
    return res.json({
      ok: false,
      mensaje: 'No se pudo guardar. Revisá los logs de Render para ver el error exacto (secreto incorrecto, despliegue sin acceso público, etc).',
    });
  }

  const historial = await obtenerHistorial();
  res.json({
    ok: true,
    mensaje: 'Se guardó una fila de prueba y se pudo volver a leer el historial. Revisá tu hoja de Sheets: deberías ver una fila con "prueba_conexion". Podés borrar esa fila cuando quieras, no afecta nada.',
    totalFilasEnHistorial: historial.length,
  });
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

  const dbInicial = leerDB();
  const matchId = Object.keys(dbInicial.partidos).find((id) => dbInicial.partidos[id].mensajeMarcadorId === respondeAId);
  if (!matchId) return res.sendStatus(200);

  const partido = dbInicial.partidos[matchId];
  const coincidencia = mensaje.text.match(/(\d+)\s*[-:xX]\s*(\d+)/);
  if (!coincidencia) {
    await enviarTelegram('No pude entender ese marcador. Respondé con el formato "2-1".');
    return res.sendStatus(200);
  }

  const golesLocal = parseInt(coincidencia[1], 10);
  const golesVisita = parseInt(coincidencia[2], 10);
  const golesTotales = golesLocal + golesVisita;

  let acierto = null;
  const lineaNum = parseFloat(LINEA_PRINCIPAL);
  if (partido.prediccion === 'OVER') acierto = golesTotales > lineaNum;
  else if (partido.prediccion === 'UNDER') acierto = golesTotales < lineaNum;

  // Elección forzada (siempre hay una, salvo que nunca se haya podido
  // calcular el movimiento por falta de datos mínimos). Regla pedida:
  // si eligió OVER, se valida con más de 0.5 goles; si eligió UNDER,
  // con menos de 4.5 goles.
  let aciertoForzado = null;
  if (partido.direccionForzada === 'OVER') aciertoForzado = golesTotales > 0.5;
  else if (partido.direccionForzada === 'UNDER') aciertoForzado = golesTotales < 4.5;

  await guardarEnHistorial({
    fecha: new Date().toISOString(),
    liga: partido.sportKey,
    partido: `${partido.homeTeam} vs ${partido.awayTeam}`,
    linea: LINEA_PRINCIPAL,
    prediccion: partido.prediccion || 'SIN_APUESTA',
    golesTotales,
    marcador: `${golesLocal}-${golesVisita}`,
    acierto,
    cuotaOverApertura: partido.cuotaOverApertura ?? '',
    cuotaOverCierre: partido.cuotaOverCierre ?? '',
    puntosUsados: partido.puntosUsados ?? '',
    movimientoOver: partido.movimientoOver ?? '',
    sostenidaOver: partido.sostenidaOver ?? '',
    movimientoUnder: partido.movimientoUnder ?? '',
    sostenidaUnder: partido.sostenidaUnder ?? '',
    cuotaUnderApertura: partido.cuotaUnderApertura ?? '',
    cuotaUnderCierre: partido.cuotaUnderCierre ?? '',
    direccionForzada: partido.direccionForzada ?? '',
    aciertoForzado,
    senalPonderada: partido.senalPonderada ?? '',
    mov15Over: partido.mov15Over ?? '',
    sost15Over: partido.sost15Over ?? '',
    mov15Under: partido.mov15Under ?? '',
    sost15Under: partido.sost15Under ?? '',
    mov25Over: partido.mov25Over ?? '',
    sost25Over: partido.sost25Over ?? '',
    mov25Under: partido.mov25Under ?? '',
    sost25Under: partido.sost25Under ?? '',
    mov35Over: partido.mov35Over ?? '',
    sost35Over: partido.sost35Over ?? '',
    mov35Under: partido.mov35Under ?? '',
    sost35Under: partido.sost35Under ?? '',
    mov45Over: partido.mov45Over ?? '',
    sost45Over: partido.sost45Over ?? '',
    mov45Under: partido.mov45Under ?? '',
    sost45Under: partido.sost45Under ?? '',
  });

  const resultadoTexto = acierto === true ? '🎉 ¡Acertaste!' : acierto === false ? '❌ No acertó.' : 'ℹ️ Registrado (no hubo apuesta).';
  await enviarTelegram(`✅ Marcador registrado: ${golesLocal}-${golesVisita} (${golesTotales} goles). ${resultadoTexto}`);

  // El borrado se hace con una lectura fresca, recién ahora, para no
  // pisar cambios que otros partidos hayan guardado mientras se hacían
  // las llamadas de arriba (historial, Telegram).
  await conBloqueoDB(() => {
    const db = leerDB();
    delete db.partidos[matchId];
    guardarDB(db);
  });

  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================================================================
// INICIO DEL SERVIDOR
// ==================================================================

app.listen(PORT, async () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
  if (!ODDS_API_KEY) console.warn('⚠️  Falta THE_ODDS_API_KEY en el archivo .env');
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) console.warn('⚠️  Falta configuración de Telegram en el archivo .env');
  if (!GOOGLE_SHEETS_WEBHOOK_URL) console.warn('⚠️  Falta GOOGLE_SHEETS_WEBHOOK_URL: el historial no se va a guardar.');
  await recuperarEstadoSiHaceFalta();
  restaurarProgramacionAlIniciar();
  programarBusquedaDiaria();
  configurarWebhookTelegram();
});
