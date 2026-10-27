```python
import os

with open('bot_unzipped/over-under-bot-v3-main/server.js', 'r', encoding='utf-8') as f:
    server_js_content = f.read()

# Let's check the function obtenerCuotasTotales specifically since that will be highly modified.
start_idx = server_js_content.find('async function obtenerCuotasTotales')
end_idx = server_js_content.find('// ==================================================================', start_idx)

print("Original obtenerCuotasTotales implementation:")
print(server_js_content[start_idx:end_idx])


```

```text
Original obtenerCuotasTotales implementation:
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




```

Aquí tienes el **`server.js` reescrito por completo**.

He integrado absolutamente todo lo que acordamos: la extracción de datos crudos (con la cuota específica de Pinnacle y el número de casas), el cálculo matemático de Goles Esperados (xG) usando probabilidades implícitas sin margen, la nueva regla de decisión única evaluada contra la línea 3.5, el soporte para dar de baja partidos a las 48h con marcador vacío, y los 4 tipos de envíos a tu Google Apps Script (`estado`, `chequeo`, `crudo`, e `historial`).

### Reemplaza todo el contenido de tu `server.js` por este código:

```javascript:server.js
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

// Ligas permitidas
const LIGAS_PERMITIDAS = [
  'soccer_epl', 'soccer_efl_champ', 'soccer_germany_bundesliga', 'soccer_spain_la_liga',
  'soccer_italy_serie_a', 'soccer_france_ligue_one', 'soccer_netherlands_eredivisie',
  'soccer_portugal_primeira_liga', 'soccer_brazil_campeonato', 'soccer_mexico_ligamx',
  'soccer_usa_mls', 'soccer_argentina_primera_division', 'soccer_uefa_champs_league',
];

const CHECKPOINTS = [
  { clave: '24h', ms: 24 * 60 * 60 * 1000 },
  { clave: '6h', ms: 6 * 60 * 60 * 1000 },
  { clave: '1h', ms: 1 * 60 * 60 * 1000 },
  { clave: '5m', ms: 5 * 60 * 1000 },
];

const LINEAS_A_RASTREAR = [1.5, 2.5, 3.5, 4.5];
const LINEAS_XG = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5]; // Para calcular goles esperados
const LINEA_PRINCIPAL = '3.5';
const VERSION_REGLA = 'v3.5';

const GAP_MINIMO_MS = (1 * 60 + 55) * 60 * 1000; // 1h55min
const VENTANA_INICIO_MIN = 6 * 60;
const VENTANA_FIN_MIN = 23 * 60;
const OBJETIVO_MENSUAL = 120; // Tope para proteger API

const HORA_BUSQUEDA_DIARIA = process.env.HORA_BUSQUEDA_DIARIA || '05:00';
const ZONA_HORARIA = process.env.ZONA_HORARIA || 'America/Lima';

let trabajosActivos = [];

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================================================================
// BASE DE DATOS Y ESTADO (Tolerancia a fallos)
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
  enviarASheets({ tipo: 'estado', datos: JSON.stringify(data) }).catch(() => {});
}

let colaOperacionesDB = Promise.resolve();
function conBloqueoDB(tarea) {
  const resultado = colaOperacionesDB.then(tarea, tarea);
  colaOperacionesDB = resultado.then(() => {}, () => {});
  return resultado;
}

// ==================================================================
// COMUNICACIÓN CON GOOGLE SHEETS (La nueva API)
// ==================================================================

async function enviarASheets(payload) {
  if (!GOOGLE_SHEETS_WEBHOOK_URL) return false;
  try {
    const res = await fetch(GOOGLE_SHEETS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secreto: GOOGLE_SHEETS_SECRETO, ...payload }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.ok;
  } catch (err) {
    console.error(`Error de red enviando a Sheets (${payload.tipo || 'historial'}):`, err.message);
    return false;
  }
}

async function recuperarEstadoSiHaceFalta() {
  const dbLocal = leerDB();
  if (Object.keys(dbLocal.partidos).length > 0) return;
  if (!GOOGLE_SHEETS_WEBHOOK_URL) return;

  console.log('🔄 Buscando copia de estado en curso en Sheets...');
  try {
    const res = await fetch(`${GOOGLE_SHEETS_WEBHOOK_URL}?secreto=${encodeURIComponent(GOOGLE_SHEETS_SECRETO)}&tipo=estado`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.ok && data.estado) {
      const parseado = JSON.parse(data.estado);
      if (!parseado.partidos) parseado.partidos = {};
      if (Object.keys(parseado.partidos).length > 0) {
        fs.writeFileSync(DB_PATH, JSON.stringify(parseado, null, 2), 'utf-8');
        console.log(`✅ Recuperados ${Object.keys(parseado.partidos).length} partido(s) en curso.`);
      }
    }
  } catch (err) {
    console.error('No se pudo recuperar el estado:', err.message);
  }
}

// ==================================================================
// TELEGRAM
// ==================================================================

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
  const urlWebhook = `${urlPublica}/api/telegram-webhook/${TELEGRAM_WEBHOOK_SECRET}`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: urlWebhook }),
    });
    const data = await res.json();
    if (data.ok) console.log(`✅ Webhook Telegram configurado.`);
  } catch (err) {}
}

// ==================================================================
// THE ODDS API & CÁLCULOS
// ==================================================================

async function obtenerEventosLiga(sportKey) {
  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/events?apiKey=${ODDS_API_KEY}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const eventos = await res.json();
    return eventos.map((e) => ({ ...e, sportKey }));
  } catch (err) {
    return [];
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
      const mercadoTotals = casa.markets.find((m) => m.key === 'alternate_totals');
      if (!mercadoTotals) continue;
      
      const updateTime = casa.last_update;

      for (const outcome of mercadoTotals.outcomes) {
        const clave = String(outcome.point);
        const esOver = outcome.name === 'Over';
        
        // Recolección para promedio (solo si es línea rastreada/xG)
        if (acumuladorPromedios[clave]) {
          if (esOver) acumuladorPromedios[clave].overs.push(outcome.price);
          else acumuladorPromedios[clave].unders.push(outcome.price);
        }

        // Datos crudos y específicos
        if (LINEAS_A_RASTREAR.includes(outcome.point) || LINEAS_XG.includes(outcome.point)) {
          // Buscamos a la pareja (el under del over, o viceversa) para armar la fila cruda
          const outcomePareja = mercadoTotals.outcomes.find(o => o.point === outcome.point && o.name !== outcome.name);
          
          if (esOver && outcomePareja) {
             filasCrudas.push({
               fechaCaptura, partidoId: eventId, chequeo: claveCheckpoint,
               casa: casa.title, linea: clave, cuotaOver: outcome.price,
               cuotaUnder: outcomePareja.price, ultimaActualizacion: updateTime
             });

             // Captura de Pinnacle y métricas de la línea principal (3.5)
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

    return { 
      lineas: lineasPromedio, 
      filasCrudas, 
      creditosRestantes, 
      pinnacle35, 
      cantidadCasas: casasEn35.size,
      horaInicioApi 
    };

  } catch (err) {
    return null;
  }
}

// Cálculo matemático de xG basado en la suma de probabilidades acumuladas.
// E[X] = P(X>0) + P(X>1) + P(X>2) + ...
// P(X>k) es la probabilidad "Over k.5"
function calcularXG(lineas) {
  if (!lineas) return '';
  let xg = 0;
  for (const n of LINEAS_XG) {
    const key = String(n);
    if (lineas[key] && lineas[key].over && lineas[key].under) {
      const pOverImpl = 1 / lineas[key].over;
      const pUnderImpl = 1 / lineas[key].under;
      const fairProbOver = pOverImpl / (pOverImpl + pUnderImpl);
      xg += fairProbOver;
    }
  }
  return xg > 0 ? Number(xg.toFixed(2)) : '';
}

// ==================================================================
// SELECCIÓN Y PROGRAMACIÓN
// ==================================================================

function crearRegistroPartido(evento, diaLocal, etiqueta) {
  return {
    id: evento.id, sportKey: evento.sportKey, homeTeam: evento.home_team, awayTeam: evento.away_team,
    commenceTime: evento.commence_time, diaLocal, etiqueta, cuotas: {},
    prediccionEnviada: false, prediccion: null, mensajeMarcadorId: null
  };
}

function enVentanaHoraria(fechaIso) {
  const min = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: ZONA_HORARIA, hour: '2-digit', hourCycle: 'h23' }).format(new Date(fechaIso))) * 60 
            + parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: ZONA_HORARIA, minute: '2-digit' }).format(new Date(fechaIso)));
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

  const candidatosA = todosLosEventos.filter((e) => new Date(e.commence_time).getTime() - ahora >= 24 * 3600000);
  if (candidatosA.length === 0) return { ok: false, mensaje: 'No hay partidos a más de 24h.' };

  const anclaDelDia = candidatosA[0];
  const diaSeleccionado = obtenerDiaLocal(anclaDelDia.commence_time);

  return conBloqueoDB(async () => {
    const db = leerDB();
    
    // 48h Timeout Cleanup
    for (const id in db.partidos) {
      const p = db.partidos[id];
      const horas = (Date.now() - new Date(p.commenceTime).getTime()) / 3600000;
      if (p.prediccionEnviada && horas > 48) {
        await cerrarPartidoEnHistorial(p, ""); // Marcador vacío
        delete db.partidos[id];
      }
    }

    if (Object.values(db.partidos).some((p) => p.diaLocal === diaSeleccionado && !p.prediccionEnviada)) {
      return { bloqueado: true, mensaje: `Ya hay partidos programados para el ${diaSeleccionado}.` };
    }

    const mesActual = obtenerDiaLocal(new Date().toISOString()).slice(0, 7);
    if (!db.contadorMes || db.contadorMes.mes !== mesActual) db.contadorMes = { mes: mesActual, seleccionados: 0 };
    const restantes = OBJETIVO_MENSUAL - db.contadorMes.seleccionados;
    if (restantes <= 0) return { bloqueado: true, mensaje: `Límite mensual de ${OBJETIVO_MENSUAL} alcanzado.` };

    const eventosDelDia = todosLosEventos.filter(e => obtenerDiaLocal(e.commence_time) === diaSeleccionado && new Date(e.commence_time).getTime() >= new Date(anclaDelDia.commence_time).getTime());
    
    const seleccionados = [anclaDelDia];
    let ultimoTiempo = new Date(anclaDelDia.commence_time).getTime();
    for (const ev of eventosDelDia) {
      if (seleccionados.length >= restantes) break;
      if (ev.id === anclaDelDia.id) continue;
      const t = new Date(ev.commence_time).getTime();
      if (t - ultimoTiempo >= GAP_MINIMO_MS) { seleccionados.push(ev); ultimoTiempo = t; }
    }

    seleccionados.forEach((ev, i) => {
      const p = crearRegistroPartido(ev, diaSeleccionado, i < 26 ? String.fromCharCode(65 + i) : `P${i + 1}`);
      db.partidos[ev.id] = p;
      programarChequeos(ev.id, p);
    });
    db.contadorMes.seleccionados += seleccionados.length;
    guardarDB(db);

    const txt = seleccionados.map(e => `▫️ ${e.home_team} vs ${e.away_team}`).join('\n');
    await enviarTelegram(`✅ ${seleccionados.length} partido(s) programado(s):\n\n${txt}`);
    return { ok: true, mensaje: `${seleccionados.length} programados.` };
  });
}

function programarChequeos(matchId, partido) {
  const tiempoInicio = new Date(partido.commenceTime).getTime();
  for (const cp of CHECKPOINTS) {
    if (partido.cuotas && partido.cuotas[cp.clave]) continue;
    const ejecucion = new Date(tiempoInicio - cp.ms);
    
    if (ejecucion.getTime() <= Date.now()) {
      if (tiempoInicio > Date.now()) {
        console.log(`⏰ Checkpoint ${cp.clave} atrasado, ejecutando ahora.`);
        ejecutarChequeo(matchId, cp.clave, true);
      }
      continue;
    }
    trabajosActivos.push(schedule.scheduleJob(ejecucion, () => ejecutarChequeo(matchId, cp.clave, false)));
  }
}

async function ejecutarChequeo(matchId, cpClave, recuperadoTarde) {
  const pInicial = leerDB().partidos[matchId];
  if (!pInicial) return;

  let datos = null;
  for (let i = 1; i <= 3; i++) {
    datos = await obtenerCuotasTotales(pInicial.sportKey, pInicial.id, cpClave);
    if (datos) break;
    await new Promise(r => setTimeout(r, 30000));
  }

  if (datos) {
    // 1. Enviar Logs de Chequeo y Crudos a Sheets
    enviarASheets({
      tipo: 'chequeo',
      fechaCaptura: new Date().toISOString(),
      partidoId: pInicial.id, partido: `${pInicial.homeTeam} vs ${pInicial.awayTeam}`,
      chequeo: cpClave, horaInicioApi: datos.horaInicioApi,
      creditosRestantes: datos.creditosRestantes, cantidadCasas: datos.cantidadCasas
    }).catch(()=>{});

    if (datos.filasCrudas.length > 0) {
      enviarASheets({ tipo: 'crudo', filasCrudas: datos.filasCrudas }).catch(()=>{});
    }

    // 2. Guardar estado local
    await conBloqueoDB(() => {
      const db = leerDB();
      if (!db.partidos[matchId]) return;
      db.partidos[matchId].cuotas[cpClave] = { 
        lineas: datos.lineas, 
        pinnacle35: datos.pinnacle35, 
        casas35: datos.cantidadCasas, 
        horaInicioReal: datos.horaInicioApi,
        recuperadoTarde: recuperadoTarde
      };
      guardarDB(db);
    });
  }

  if (cpClave === '5m') await ejecutarPrediccion(matchId);
}

// ==================================================================
// ALGORITMO (DECISIÓN ÚNICA Y EVALUACIÓN 3.5)
// ==================================================================

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
    if (!p) return;

    const clavesDisp = CHECKPOINTS.map(c => c.clave).filter(c => p.cuotas[c] && p.cuotas[c].lineas && p.cuotas[c].lineas[LINEA_PRINCIPAL]);
    const datosMinimos = clavesDisp.includes('24h') && clavesDisp.includes('5m');
    
    let mensaje = '';
    let prediccion = 'SIN_APUESTA'; // Fallback

    if (datosMinimos) {
      // Registrar Datos de Apertura y Cierre
      const ap = p.cuotas['24h'];
      const ci = p.cuotas['5m'];
      
      p.horaInicioReal = ci.horaInicioReal || ap.horaInicioReal;
      p.casas35 = ci.casas35 || ap.casas35 || 0;
      p.pinnacleOverApertura = ap.pinnacle35?.over;
      p.pinnacleOverCierre = ci.pinnacle35?.over;
      p.xgApertura = calcularXG(ap.lineas);
      p.xgCierre = calcularXG(ci.lineas);
      p.recuperadoTarde = ap.recuperadoTarde || false;
      p.puntosUsados = `${clavesDisp.length}/4`;

      p.cuotaOverApertura = ap.lineas[LINEA_PRINCIPAL].over;
      p.cuotaUnderApertura = ap.lineas[LINEA_PRINCIPAL].under;
      p.cuotaOverCierre = ci.lineas[LINEA_PRINCIPAL].over;
      p.cuotaUnderCierre = ci.lineas[LINEA_PRINCIPAL].under;

      let senalPonderada = 0;
      let sumaPesos = 0;

      for (const line of LINEAS_A_RASTREAR) {
        const lStr = String(line);
        if (!clavesDisp.every(c => p.cuotas[c].lineas[lStr])) continue;
        
        const sOver = clavesDisp.map(c => (1 / p.cuotas[c].lineas[lStr].over)*100);
        const aOver = analizarSerie(sOver);
        const suf = lStr.replace('.', '');
        
        p[`mov${suf}Over`] = Number(aOver.delta.toFixed(1));
        p[`sost${suf}Over`] = aOver.sos;

        const peso = 1 - Math.abs(sOver[0] - 50) / 50;
        senalPonderada += peso * aOver.delta;
        sumaPesos += peso;
      }
      p.senalPonderada = sumaPesos > 0 ? Number((senalPonderada / sumaPesos).toFixed(2)) : 0;

      // REGLA DE DECISIÓN ÚNICA CONTRA EL 3.5
      // Prioriza el UNDER (tasa base alta) salvo confirmación alcista fuerte.
      const impulsoAlcistaFuerte = (p.mov35Over > 1.5) && p.sost35Over && (p.senalPonderada > 1.0);
      prediccion = impulsoAlcistaFuerte ? 'OVER' : 'UNDER';
      p.prediccion = prediccion;

      mensaje = `🎯 PREDICCIÓN OFICIAL: ${prediccion} 3.5 GOLES\n`+
                `⚽ ${p.homeTeam} vs ${p.awayTeam}\n`+
                `xG Apertura: ${p.xgApertura} | xG Cierre: ${p.xgCierre}\n`+
                `Señal Ponderada: ${p.senalPonderada}`;
    } else {
      mensaje = `⚠️ SIN APUESTA (Datos insuficientes) en: ${p.homeTeam} vs ${p.awayTeam}`;
    }

    await enviarTelegram(mensaje);
    p.prediccionEnviada = true;
    db.partidos[matchId] = p;
    guardarDB(db);

    const ts = new Date(new Date(p.commenceTime).getTime() + 3 * 3600000);
    trabajosActivos.push(schedule.scheduleJob(ts, () => enviarSolicitudMarcador(matchId)));
  });
}

// ==================================================================
// GUARDADO EN HISTORIAL (Sheets)
// ==================================================================

async function cerrarPartidoEnHistorial(p, marcador) {
  let golesTotales = '';
  let acierto = null;

  if (marcador) {
    const match = marcador.match(/(\d+)\s*[-:xX]\s*(\d+)/);
    if (match) {
      golesTotales = parseInt(match[1]) + parseInt(match[2]);
      if (p.prediccion === 'OVER') acierto = golesTotales > 3.5;
      else if (p.prediccion === 'UNDER') acierto = golesTotales < 3.5;
    }
  }

  const payload = {
    fecha: new Date().toISOString(),
    horaInicioReal: p.horaInicioReal || p.commenceTime,
    liga: p.sportKey,
    equipoLocal: p.homeTeam,
    equipoVisitante: p.awayTeam,
    partido: `${p.homeTeam} vs ${p.awayTeam}`,
    linea: LINEA_PRINCIPAL,
    prediccion: p.prediccion || 'SIN_APUESTA',
    golesTotales: golesTotales !== '' ? golesTotales : undefined,
    marcador: marcador || '',
    acierto,
    puntosUsados: p.puntosUsados,
    senalPonderada: p.senalPonderada,
    versionRegla: VERSION_REGLA,
    casas35: p.casas35,
    pinnacleOverApertura: p.pinnacleOverApertura,
    pinnacleOverCierre: p.pinnacleOverCierre,
    xgApertura: p.xgApertura,
    xgCierre: p.xgCierre,
    recuperadoTarde: p.recuperadoTarde,
    mov15Over: p.mov15Over, sost15Over: p.sost15Over,
    mov25Over: p.mov25Over, sost25Over: p.sost25Over,
    mov35Over: p.mov35Over, sost35Over: p.sost35Over,
    mov45Over: p.mov45Over, sost45Over: p.sost45Over,
    cuotaOverApertura: p.cuotaOverApertura, cuotaOverCierre: p.cuotaOverCierre,
    cuotaUnderApertura: p.cuotaUnderApertura, cuotaUnderCierre: p.cuotaUnderCierre,
  };

  return await enviarASheets(payload);
}

// ==================================================================
// TELEGRAM WEBHOOK (Solicitud y Respuesta de Marcador)
// ==================================================================

async function enviarSolicitudMarcador(matchId) {
  return conBloqueoDB(async () => {
    const db = leerDB();
    const p = db.partidos[matchId];
    if (!p || p.mensajeMarcadorId) return;
    const msgId = await enviarTelegram(`⚽ ¿Marcador final de ${p.homeTeam} vs ${p.awayTeam}? Respondé (ej: 2-1).`);
    if (msgId) { p.mensajeMarcadorId = msgId; guardarDB(db); }
  });
}

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
    
    if (!regex) {
      await enviarTelegram('Formato inválido. Respondé "2-1".');
      return;
    }

    const mFinal = `${regex[1]}-${regex[2]}`;
    const goles = parseInt(regex[1]) + parseInt(regex[2]);
    const exito = await cerrarPartidoEnHistorial(p, mFinal);
    
    if (exito) {
      let result = 'ℹ️ Sin apuesta.';
      if (p.prediccion === 'OVER') result = goles > 3.5 ? '🎉 ¡Acertaste!' : '❌ Fallo.';
      else if (p.prediccion === 'UNDER') result = goles < 3.5 ? '🎉 ¡Acertaste!' : '❌ Fallo.';
      await enviarTelegram(`✅ Registrado: ${mFinal} (${goles} goles). ${result}`);
      delete db.partidos[matchId];
      guardarDB(db);
    } else {
      await enviarTelegram('⚠️ Error guardando en Google Sheets. Intentá responder de nuevo.');
    }
  });

  res.sendStatus(200);
});

// ==================================================================
// RUTAS API Y CRON
// ==================================================================

app.get('/api/estado', (req, res) => {
  const partidos = Object.values(leerDB().partidos).sort((a, b) => new Date(a.commenceTime) - new Date(b.commenceTime));
  res.json({ partidos });
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

app.post('/api/buscar-partidos', async (req, res) => {
  try { res.json(await buscarYProgramarPartidos()); }
  catch (err) { res.status(500).json({ ok: false }); }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, async () => {
  console.log(`🚀 Servidor corriendo puerto ${PORT}`);
  await recuperarEstadoSiHaceFalta();
  
  // Restaurar cron jobs
  const db = leerDB();
  Object.entries(db.partidos).forEach(([id, p]) => {
    if (!p.prediccionEnviada) programarChequeos(id, p);
    else if (!p.mensajeMarcadorId) {
      const t = new Date(new Date(p.commenceTime).getTime() + 3*3600000);
      trabajosActivos.push(schedule.scheduleJob(t, () => enviarSolicitudMarcador(id)));
    }
  });

  const [h, m] = HORA_BUSQUEDA_DIARIA.split(':');
  const regla = new schedule.RecurrenceRule();
  regla.tz = ZONA_HORARIA; regla.hour = parseInt(h); regla.minute = parseInt(m);
  schedule.scheduleJob(regla, buscarYProgramarPartidos);
  
  configurarWebhookTelegram();
});
```eof

```
