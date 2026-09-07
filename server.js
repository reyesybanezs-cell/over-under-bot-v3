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

const DB_PATH = path.join(__dirname, 'database.json');

// Ligas permitidas (claves de The-Odds-API, verificadas contra su tabla
// oficial en the-odds-api.com/sports-odds-data/sports-apis.html)
const LIGAS_PERMITIDAS = [
  'soccer_epl',                        // Premier League (Inglaterra)
  'soccer_efl_champ',                  // Championship (2ª Inglaterra)
  'soccer_germany_bundesliga',         // Bundesliga (Alemania)
  'soccer_spain_la_liga',              // La Liga (España)
  'soccer_italy_serie_a',              // Serie A (Italia)
  'soccer_france_ligue_one',           // Ligue 1 (Francia)
  'soccer_netherlands_eredivisie',     // Eredivisie (Países Bajos)
  'soccer_portugal_primeira_liga',     // Primeira Liga (Portugal)
  'soccer_brazil_campeonato',          // Brasileirão (Brasil)
  'soccer_mexico_ligamx',              // Liga MX (México)
  'soccer_usa_mls',                    // MLS (EE.UU.)
  'soccer_argentina_primera_division', // Primera División Argentina
  'soccer_uefa_champs_league',         // UEFA Champions League
];

// Puntos de chequeo antes del inicio de cada partido
const CHECKPOINTS = [
  { clave: '24h', ms: 24 * 60 * 60 * 1000 },
  { clave: '12h', ms: 12 * 60 * 60 * 1000 },
  { clave: '2h', ms: 2 * 60 * 60 * 1000 },
  { clave: '1h', ms: 1 * 60 * 60 * 1000 },
  { clave: '5m', ms: 5 * 60 * 1000 },
];

// Línea sobre la que se toma la decisión final (Over/Under).
const LINEA_PRINCIPAL = '2.5';
// Líneas vecinas que solo se usan como señal de confirmación, para
// reforzar (o no) la confianza en la sugerencia de la línea principal.
const LINEAS_CONFIRMACION = ['1.5', '3.5'];
// Todas las líneas que se piden y guardan en cada chequeo.
const LINEAS_A_RASTREAR = [1.5, 2.5, 3.5];

const UMBRAL_MOVIMIENTO = 3; // puntos porcentuales de probabilidad implícita

// Hora local (formato "HH:MM", 24h) a la que se ejecuta la búsqueda
// automática de los 2 partidos del día. Se puede cambiar en el .env.
const HORA_BUSQUEDA_DIARIA = process.env.HORA_BUSQUEDA_DIARIA || '08:00';

// Referencias a los jobs en memoria, para poder cancelarlos si se
// vuelve a presionar el botón de búsqueda.
let trabajosActivos = [];

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================================================================
// BASE DE DATOS (archivo JSON local)
// ==================================================================

function leerDB() {
  if (!fs.existsSync(DB_PATH)) {
    return {};
  }
  try {
    const contenido = fs.readFileSync(DB_PATH, 'utf-8');
    return JSON.parse(contenido || '{}');
  } catch (err) {
    console.error('Error leyendo database.json:', err.message);
    return {};
  }
}

function guardarDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// ==================================================================
// TELEGRAM
// ==================================================================

async function enviarTelegram(mensaje) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('Falta TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID en el archivo .env');
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: mensaje }),
    });
    if (!res.ok) {
      console.error('Error enviando mensaje a Telegram:', await res.text());
    }
  } catch (err) {
    console.error('Error de red enviando a Telegram:', err.message);
  }
}

// ==================================================================
// THE ODDS API
// ==================================================================

// Lista de próximos eventos de una liga (endpoint liviano, no consume
// cupo de cuotas, solo lista partidos programados).
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

// Cuotas Over/Under de un partido específico, para varias líneas de goles
// (1.5, 2.5, 3.5), promediando entre todas las casas de apuestas.
// Devuelve algo como: { '1.5': {over, under}, '2.5': {over, under}, '3.5': {over, under} }
// Si alguna línea no tiene datos suficientes, simplemente no aparece en el objeto.
async function obtenerCuotasTotales(sportKey, eventId) {
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${eventId}/odds?apiKey=${ODDS_API_KEY}&regions=eu&markets=totals&oddsFormat=decimal`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Error obteniendo cuotas del evento ${eventId}: ${res.status}`);
      return null;
    }
    const data = await res.json();

    // acumulador[punto] = { overs: [...], unders: [...] }
    const acumulador = {};
    for (const puntoNum of LINEAS_A_RASTREAR) {
      acumulador[String(puntoNum)] = { overs: [], unders: [] };
    }

    for (const casa of data.bookmakers || []) {
      const mercadoTotals = casa.markets.find((m) => m.key === 'totals');
      if (!mercadoTotals) continue;
      for (const outcome of mercadoTotals.outcomes) {
        const claveLinea = String(outcome.point);
        if (!acumulador[claveLinea]) continue; // línea que no nos interesa
        if (outcome.name === 'Over') acumulador[claveLinea].overs.push(outcome.price);
        if (outcome.name === 'Under') acumulador[claveLinea].unders.push(outcome.price);
      }
    }

    const promedio = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const resultado = {};
    for (const [linea, valores] of Object.entries(acumulador)) {
      if (valores.overs.length === 0 || valores.unders.length === 0) continue;
      resultado[linea] = {
        over: Number(promedio(valores.overs).toFixed(2)),
        under: Number(promedio(valores.unders).toFixed(2)),
      };
    }

    // Si ni siquiera la línea principal (2.5) tiene datos, lo tratamos
    // como un fallo de este chequeo.
    if (!resultado[LINEA_PRINCIPAL]) return null;

    return resultado;
  } catch (err) {
    console.error(`Error de red obteniendo cuotas del evento ${eventId}:`, err.message);
    return null;
  }
}

// ==================================================================
// SELECCIÓN DE PARTIDOS
// ==================================================================

function crearRegistroPartido(evento) {
  return {
    id: evento.id,
    sportKey: evento.sportKey,
    homeTeam: evento.home_team,
    awayTeam: evento.away_team,
    commenceTime: evento.commence_time,
    cuotas: {},
    prediccionEnviada: false,
  };
}

function formatearFecha(iso) {
  return new Date(iso).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
}

// Zona horaria usada para decidir qué es "el mismo día". Perú no tiene
// horario de verano, así que America/Lima es un ancla estable (UTC-5 fijo).
// Se puede sobreescribir con la variable de entorno ZONA_HORARIA si algún
// día usas el bot desde otro país.
const ZONA_HORARIA = process.env.ZONA_HORARIA || 'America/Lima';

function obtenerDiaLocal(fechaIso, zona) {
  // 'en-CA' da el formato AAAA-MM-DD, cómodo para comparar como texto.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zona,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(fechaIso));
}

function mismoDiaLocal(fechaIsoA, fechaIsoB, zona) {
  return obtenerDiaLocal(fechaIsoA, zona) === obtenerDiaLocal(fechaIsoB, zona);
}

async function buscarYProgramarPartidos() {
  const ahora = Date.now();
  const VEINTICUATRO_HORAS = 24 * 60 * 60 * 1000;
  const TRES_HORAS = 3 * 60 * 60 * 1000;

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

  // Candidatos válidos para el primer partido de la cadena: deben
  // iniciar en 24h o más desde ahora.
  const candidatosA = todosLosEventos.filter(
    (e) => new Date(e.commence_time).getTime() - ahora >= VEINTICUATRO_HORAS
  );

  if (candidatosA.length === 0) {
    const msg = '⚠️ No se encontró ningún partido que inicie en 24h o más desde ahora.';
    await enviarTelegram(msg);
    return { ok: false, mensaje: msg };
  }

  // Tomamos el primer candidato cronológico como ancla del día. A partir
  // de ahí, armamos una cadena de hasta 3 partidos EL MISMO DÍA (zona
  // horaria ZONA_HORARIA), cada uno con 3h+ de diferencia respecto al
  // anterior (es decir, hasta 6h entre el primero y el tercero). Si ese
  // día no da para 3, se usan 2; si no da para 2, se usa solo 1.
  const anclaDelDia = candidatosA[0];
  const diaSeleccionado = obtenerDiaLocal(anclaDelDia.commence_time, ZONA_HORARIA);
  const eventosDelDia = todosLosEventos.filter(
    (e) =>
      obtenerDiaLocal(e.commence_time, ZONA_HORARIA) === diaSeleccionado &&
      new Date(e.commence_time).getTime() >= new Date(anclaDelDia.commence_time).getTime()
  ); // ya viene ordenado cronológicamente, porque todosLosEventos lo está

  const MAX_PARTIDOS = 3;
  const seleccionados = [anclaDelDia];
  let ultimoTiempo = new Date(anclaDelDia.commence_time).getTime();

  for (const evento of eventosDelDia) {
    if (seleccionados.length >= MAX_PARTIDOS) break;
    if (evento.id === anclaDelDia.id) continue;
    const tiempoEvento = new Date(evento.commence_time).getTime();
    if (tiempoEvento - ultimoTiempo >= TRES_HORAS) {
      seleccionados.push(evento);
      ultimoTiempo = tiempoEvento;
    }
  }

  // Cancela cualquier programación anterior antes de crear una nueva
  trabajosActivos.forEach((job) => job.cancel());
  trabajosActivos = [];

  const LETRAS = ['A', 'B', 'C'];
  const db = {};
  seleccionados.forEach((evento, i) => {
    db[`partido${LETRAS[i]}`] = crearRegistroPartido(evento);
  });
  guardarDB(db);

  Object.keys(db).forEach((clave) => programarChequeos(clave, db[clave]));

  const emojisLetra = { A: '🅰️', B: '🅱️', C: '🇨' };
  const bloques = seleccionados.map(
    (evento, i) =>
      `${emojisLetra[LETRAS[i]]} ${evento.home_team} vs ${evento.away_team}\n🕒 ${formatearFecha(evento.commence_time)}`
  );
  const mensaje = `✅ ${seleccionados.length} partido(s) programado(s):\n\n${bloques.join('\n\n')}`;
  await enviarTelegram(mensaje);

  return { ok: true, mensaje: `${seleccionados.length} partido(s) programado(s) correctamente.`, db };
}

// ==================================================================
// PROGRAMACIÓN DE CHEQUEOS (node-schedule)
// ==================================================================

function programarChequeos(clavePartido, partido) {
  const tiempoInicio = new Date(partido.commenceTime).getTime();

  for (const checkpoint of CHECKPOINTS) {
    // Si ya tenemos datos guardados para este checkpoint (por ejemplo,
    // tras reiniciar el servidor), no lo reprogramamos.
    if (partido.cuotas && partido.cuotas[checkpoint.clave]) continue;

    const momentoEjecucion = new Date(tiempoInicio - checkpoint.ms);
    if (momentoEjecucion.getTime() <= Date.now()) {
      console.log(`⏭️  Checkpoint ${checkpoint.clave} de ${clavePartido} ya pasó, se omite.`);
      continue;
    }

    const job = schedule.scheduleJob(momentoEjecucion, () => {
      ejecutarChequeo(clavePartido, checkpoint.clave);
    });
    trabajosActivos.push(job);
    console.log(
      `📅 Programado chequeo "${checkpoint.clave}" de ${clavePartido} para ${momentoEjecucion.toLocaleString('es-ES')}`
    );
  }
}

async function ejecutarChequeo(clavePartido, claveCheckpoint) {
  const db = leerDB();
  const partido = db[clavePartido];
  if (!partido) {
    console.log(`${clavePartido} ya no existe en la base de datos, se omite el chequeo.`);
    return;
  }

  console.log(`🔍 Chequeo "${claveCheckpoint}" para ${partido.homeTeam} vs ${partido.awayTeam}`);
  const lineas = await obtenerCuotasTotales(partido.sportKey, partido.id);

  if (!lineas) {
    console.log(`No se pudieron obtener cuotas para ${clavePartido} (${claveCheckpoint}).`);
  } else {
    partido.cuotas[claveCheckpoint] = { lineas, timestamp: new Date().toISOString() };
    db[clavePartido] = partido;
    guardarDB(db);
    const principal = lineas[LINEA_PRINCIPAL];
    console.log(
      `✔️ Cuotas guardadas (${claveCheckpoint}): Over ${principal.over} / Under ${principal.under} [línea ${LINEA_PRINCIPAL}]`
    );
  }

  if (claveCheckpoint === '5m') {
    await ejecutarPrediccion(clavePartido);
  }
}

// ==================================================================
// ALGORITMO DE PREDICCIÓN (movimiento de línea)
// ==================================================================

function calcularProbabilidadImplicita(cuotaDecimal) {
  return (1 / cuotaDecimal) * 100;
}

async function ejecutarPrediccion(clavePartido) {
  const db = leerDB();
  const partido = db[clavePartido];
  if (!partido) return;

  const nombrePartido = `${partido.homeTeam} vs ${partido.awayTeam}`;

  // Usamos el chequeo de 24h como referencia (más margen para detectar
  // tendencia). Si por algún motivo no se pudo leer (por ejemplo, el
  // servidor se reinició justo en ese momento), usamos el de 12h.
  const referencia = partido.cuotas['24h'] || partido.cuotas['12h'];
  const final = partido.cuotas['5m'];

  let mensaje;

  const refPrincipal = referencia && referencia.lineas && referencia.lineas[LINEA_PRINCIPAL];
  const finPrincipal = final && final.lineas && final.lineas[LINEA_PRINCIPAL];

  if (!refPrincipal || !finPrincipal) {
    mensaje = `⚠️ SIN APUESTA (Datos insuficientes) en: ${nombrePartido}`;
  } else {
    const pOverRef = calcularProbabilidadImplicita(refPrincipal.over);
    const pOverFin = calcularProbabilidadImplicita(finPrincipal.over);
    const pUnderRef = calcularProbabilidadImplicita(refPrincipal.under);
    const pUnderFin = calcularProbabilidadImplicita(finPrincipal.under);

    const deltaOver = pOverFin - pOverRef;
    const deltaUnder = pUnderFin - pUnderRef;

    let direccion = null; // 'over' | 'under' | null
    if (deltaOver >= UMBRAL_MOVIMIENTO) direccion = 'over';
    else if (deltaUnder >= UMBRAL_MOVIMIENTO) direccion = 'under';

    if (!direccion) {
      mensaje =
        `⚠️ SIN APUESTA (Mercado Incierto) en: ${nombrePartido}\n\n` +
        `Línea ${LINEA_PRINCIPAL} — Δ Over: ${deltaOver.toFixed(1)} pts | Δ Under: ${deltaUnder.toFixed(1)} pts`;
    } else {
      // Buscamos confirmación en las líneas vecinas (1.5 / 3.5): si esa
      // línea también se movió 3pts+ en la MISMA dirección, la sumamos
      // como confirmación. Esto no genera una alerta aparte, solo
      // refuerza (o no) la única sugerencia de la línea principal.
      const confirmadas = [];
      const sinDatos = [];
      for (const linea of LINEAS_CONFIRMACION) {
        const refL = referencia.lineas && referencia.lineas[linea];
        const finL = final.lineas && final.lineas[linea];
        if (!refL || !finL) {
          sinDatos.push(linea);
          continue;
        }
        const dOverL = calcularProbabilidadImplicita(finL.over) - calcularProbabilidadImplicita(refL.over);
        const dUnderL = calcularProbabilidadImplicita(finL.under) - calcularProbabilidadImplicita(refL.under);
        const movioComoPrincipal =
          (direccion === 'over' && dOverL >= UMBRAL_MOVIMIENTO) ||
          (direccion === 'under' && dUnderL >= UMBRAL_MOVIMIENTO);
        if (movioComoPrincipal) confirmadas.push(linea);
      }

      let lineaConfirmacion;
      if (confirmadas.length > 0) {
        lineaConfirmacion = `✅ Confirmado también en línea(s): ${confirmadas.join(', ')}`;
      } else if (sinDatos.length === LINEAS_CONFIRMACION.length) {
        lineaConfirmacion = 'ℹ️ Sin datos de líneas 1.5/3.5 para confirmar.';
      } else {
        lineaConfirmacion = 'ℹ️ Sin confirmación en las líneas 1.5/3.5 (señal aislada en la línea 2.5).';
      }

      if (direccion === 'over') {
        mensaje =
          `🚨 OVER ${LINEA_PRINCIPAL} GOLES - Tendencia Profesional en: ${nombrePartido}\n\n` +
          `Prob. implícita Over: ${pOverRef.toFixed(1)}% → ${pOverFin.toFixed(1)}% (+${deltaOver.toFixed(1)} pts)\n` +
          `Cuota Over: ${refPrincipal.over} → ${finPrincipal.over}\n` +
          `${lineaConfirmacion}`;
      } else {
        mensaje =
          `🚨 UNDER ${LINEA_PRINCIPAL} GOLES - Tendencia Profesional en: ${nombrePartido}\n\n` +
          `Prob. implícita Under: ${pUnderRef.toFixed(1)}% → ${pUnderFin.toFixed(1)}% (+${deltaUnder.toFixed(1)} pts)\n` +
          `Cuota Under: ${refPrincipal.under} → ${finPrincipal.under}\n` +
          `${lineaConfirmacion}`;
      }
    }
  }

  await enviarTelegram(mensaje);
  partido.prediccionEnviada = true;
  db[clavePartido] = partido;
  guardarDB(db);
}

// ==================================================================
// RESTAURAR PROGRAMACIÓN AL INICIAR EL SERVIDOR
// (importante si el servidor se reinicia, por ejemplo en Render free)
// ==================================================================

function restaurarProgramacionAlIniciar() {
  const db = leerDB();
  Object.keys(db)
    .filter((clave) => clave.startsWith('partido'))
    .forEach((clave) => {
      const partido = db[clave];
      if (!partido || partido.prediccionEnviada) return;
      console.log(`♻️  Restaurando programación de ${clave}: ${partido.homeTeam} vs ${partido.awayTeam}`);
      programarChequeos(clave, partido);
    });
}

// ==================================================================
// BÚSQUEDA AUTOMÁTICA DIARIA
// (para no tener que presionar el botón manualmente cada día)
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
  res.json(leerDB());
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
  restaurarProgramacionAlIniciar();
  programarBusquedaDiaria();
});
