# Rastreador Over/Under 2.5 goles

Web app en Node.js + Express que selecciona hasta 3 partidos de fútbol al día,
rastrea el movimiento de sus cuotas Over/Under 2.5 en 4 momentos (12h, 2h,
1h y 5m antes del inicio) y envía alertas a Telegram.

## 1. Obtener tu API Key de The-Odds-API

1. Entra a https://the-odds-api.com/ y crea una cuenta gratuita.
2. Copia la "API Key" que te muestran en tu panel.

## 2. Crear tu Bot de Telegram (BotFather)

1. Abre Telegram y busca el usuario **@BotFather**.
2. Envíale el comando `/newbot`.
3. Ponle un nombre y un usuario (debe terminar en "bot", ej: `mis_cuotas_bot`).
4. BotFather te dará un **token** parecido a `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`. Guárdalo.

## 3. Obtener tu Chat ID

1. Busca en Telegram al usuario **@userinfobot** y presiona "Start".
2. Te responderá con tu **Id** numérico (ej: `987654321`). Guárdalo.
3. Muy importante: dile "Hola" a tu propio bot (el que creaste en el paso 2) desde tu Telegram, aunque no te responda. Esto es necesario para que el bot pueda escribirte primero.

## 4. Configurar el proyecto

1. Renombra el archivo `.env.example` a `.env`.
2. Ábrelo y rellena tus 3 datos:
   ```
   THE_ODDS_API_KEY=tu_api_key
   TELEGRAM_BOT_TOKEN=tu_token
   TELEGRAM_CHAT_ID=tu_chat_id
   ```

## 5. Probarlo en tu computadora

Necesitas tener [Node.js](https://nodejs.org/) instalado (versión 18 o superior).

```bash
npm install
npm start
```

Abre tu navegador en `http://localhost:3000`, presiona el botón y revisa tu Telegram.

## 6. Subirlo a Render.com (gratis, 24/7)

1. Sube esta carpeta a un repositorio de GitHub (puedes hacerlo desde github.com sin usar la terminal, con el botón "Add file → Upload files"). **No subas tu archivo `.env` con tus claves reales** (ya está excluido en `.gitignore`).
2. Entra a https://render.com y crea una cuenta gratuita (puedes usar tu cuenta de GitHub).
3. Click en "New +" → "Web Service".
4. Conecta tu repositorio de GitHub.
5. Configura:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free
6. En la sección "Environment Variables" agrega las 3 variables (`THE_ODDS_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) con tus valores reales.
7. Click en "Create Web Service". Render te dará una URL pública tipo `https://tu-app.onrender.com`.

### ⚠️ Importante sobre el plan gratuito de Render

Los servicios gratuitos de Render se "duermen" tras 15 minutos sin recibir
tráfico, y al dormirse pierden lo que tengan en memoria (los avisos
programados) y los cambios en el disco (`database.json`), ya que el
sistema de archivos es efímero.

Para que tu app se mantenga activa 24/7 y no pierda la programación:
- Usa un servicio gratuito de "ping" como [UptimeRobot](https://uptimerobot.com) o [cron-job.org](https://cron-job.org) para que visite tu URL (`https://tu-app.onrender.com`) cada 10 minutos. Esto evita que el servicio se duerma.
- Aun así, Render puede reiniciar el servicio ocasionalmente por mantenimiento. Por eso el servidor está preparado para, al reiniciarse, leer `database.json` y volver a programar los chequeos pendientes de los partidos ya elegidos — pero los chequeos cuyo horario ya pasó durante el reinicio no se pueden recuperar.
- Si quieres una confiabilidad total sin depender de "pings", la alternativa es pasar a un plan pago de Render (desde $7/mes), que no se duerme nunca.

## Cómo funciona la nueva versión (24h + líneas 1.5/3.5)

- Ahora se leen las cuotas en **5 momentos**: 24h, 12h, 2h, 1h y 5 minutos antes de cada partido.
- En cada lectura se guardan las 3 líneas de goles: **1.5, 2.5 y 3.5** (todas vienen en la misma llamada a la API, no gasta cuota extra).
- La decisión sigue basándose en la línea principal, **2.5**, comparando la lectura de las 24h contra la de los 5 minutos.
- Las líneas 1.5 y 3.5 **no generan alertas propias**: solo se usan para agregar una nota de "✅ confirmado" o "ℹ️ sin confirmación" al único mensaje que se manda por partido.

## Arreglos importantes (líneas 1.5 y solapamiento de días)

- **Línea 1.5 sin datos**: se corrigió pidiendo el mercado `alternate_totals` en vez de `totals`. El mercado `totals` normal solo trae la línea principal de cada casa de apuestas (casi siempre 2.5); `alternate_totals` trae todas las líneas (0.5, 1, 1.5, 2, 2.5, 3, 3.5...) en la misma llamada, sin costo extra de cuota.
- **Un partido en curso se perdía cuando llegaba la búsqueda automática del día siguiente**: ahora cada partido se guarda con su propio ID único y de forma independiente. Antes de buscar partidos nuevos, el sistema revisa si ya hay partidos programados (sin terminar) para el día que le tocaría elegir, y si es así, simplemente espera — no cancela ni sobreescribe nada. Esto significa que, si un partido queda "cruzado" con la búsqueda automática de otro día (por ejemplo, uno que arranca a las 11:45am y la búsqueda automática es a las 8:00am ese mismo día), no se pierde: sigue rastreándose hasta el final, y recién cuando termina se habilita la búsqueda del siguiente día.

## Cómo funciona la selección de partidos

- Busca el primer partido que inicie en 24h o más desde el momento de la búsqueda. Ese define "el día" de trabajo.
- A partir de ahí, arma una cadena de hasta 3 partidos ese mismo día, cada uno con 3h o más de diferencia respecto al anterior (hasta 6h entre el primero y el tercero).
- Si ese día no da para 3, usa 2. Si no da ni para 2, usa solo 1. No busca en otro día para completar el cupo — se queda con lo que haya en el primer día disponible.

## Uso diario

El sistema busca los partidos automáticamente, todos los días, a las
8:00 AM hora de Perú (puedes cambiar la hora con la variable
`HORA_BUSQUEDA_DIARIA` en el `.env` o en las variables de entorno de
Render, formato `HH:MM`). No necesitas presionar nada.

El botón "Buscar 2 Partidos y Programar" en la página web sigue ahí por
si en algún momento quieres forzar una búsqueda manual (por ejemplo,
para probar el sistema en el momento).

Recuerda que esto solo funciona de forma confiable si tu servicio de
Render está despierto a esa hora — de ahí la importancia del ping de
UptimeRobot mencionado más abajo.
