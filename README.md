# Rastreador Over/Under + BTTS

Web app en Node.js + Express que selecciona hasta 4 partidos de fútbol al
día, rastrea el movimiento de sus cuotas (goles y BTTS) en 4 momentos del
día, te manda la sugerencia a Telegram, y guarda un historial permanente
de aciertos que vos mismo alimentás respondiendo el marcador final.

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

## 4. Crear tu hoja de cálculo de historial (Google Sheets)

Esto es nuevo: el historial de aciertos vive en una hoja de Google, no en
Render, porque el disco de Render se borra en cada actualización y el
historial tiene que durar meses.

1. Andá a https://sheets.google.com y creá una hoja nueva en blanco. Ponle el nombre que quieras (ej. "Historial Over-Under").
2. Arriba, en el menú: **Extensiones → Apps Script**. Se abre un editor de código en una pestaña nueva.
3. Borrá todo el código de ejemplo que aparece ahí, y pegá completo el contenido del archivo `google-apps-script.js` que viene en este mismo proyecto.
4. Dentro de ese código, cambiá la línea `const SECRETO_COMPARTIDO = 'cambia-esto-por-algo-largo-y-unico';` por una palabra o frase larga inventada por vos (por ejemplo algo como `perro-azul-47-cancha`). Anotala, la vas a necesitar en el paso 6.
5. Arriba a la derecha, botón azul **Implementar → Nueva implementación**.
   - Tipo: hacé clic en el engranaje ⚙️ y elegí **"Aplicación web"**.
   - "Ejecutar como": tu cuenta (la única opción normalmente).
   - "Quién tiene acceso": **"Cualquier usuario"**. (Esto no le da a nadie acceso a tu hoja completa — solo permite que este script puntual reciba llamadas, y ya está protegido por el secreto del paso 4.)
   - Clic en **Implementar**. Google te va a pedir que autorices el script (es tu propio script, así que es seguro aceptar).
6. Copiá la **URL de la aplicación web** que te da (termina en `/exec`). La vas a necesitar en el paso 6 de la sección de Render.

**Importante:** si en el futuro volvés a editar el código de Apps Script, tenés que ir de nuevo a "Implementar → Gestionar implementaciones", tocar el lápiz ✏️, y elegir "Nueva versión" — si no, los cambios no se aplican.

## 5. Configurar el proyecto

1. Renombra el archivo `.env.example` a `.env`.
2. Ábrelo y rellená tus datos: `THE_ODDS_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, y ahora también:
   - `TELEGRAM_WEBHOOK_SECRET`: inventá cualquier texto largo (ej: `x7k-perro-92-cancha`).
   - `GOOGLE_SHEETS_WEBHOOK_URL`: la URL que copiaste en el paso 4.6 de arriba.
   - `GOOGLE_SHEETS_SECRETO`: **tiene que ser exactamente igual** a lo que pusiste en `SECRETO_COMPARTIDO` dentro del Apps Script.

## 6. Probarlo en tu computadora

Necesitas tener [Node.js](https://nodejs.org/) instalado (versión 18 o superior).

```bash
npm install
npm start
```

Abre tu navegador en `http://localhost:3000`. El botón y la tabla van a
funcionar, pero **el webhook de Telegram (recibir tus respuestas con el
marcador) solo funciona con una URL pública**, así que en tu computadora
esa parte no se activa — es normal, no es un error.

## 7. Subirlo a Render.com (gratis, 24/7)

1. Sube esta carpeta a un repositorio de GitHub (puedes hacerlo desde github.com sin usar la terminal, con el botón "Add file → Upload files"). **No subas `.env` ni `node_modules`** (ya están excluidos en `.gitignore`). Tampoco hace falta subir `google-apps-script.js` a Render (ese código vive en Google, no en tu servidor), pero no pasa nada si lo subís también.
2. Entra a https://render.com y crea una cuenta gratuita (puedes usar tu cuenta de GitHub).
3. Click en "New +" → "Web Service".
4. Conecta tu repositorio de GitHub.
5. Configura: **Runtime**: Node · **Build Command**: `npm install` · **Start Command**: `npm start` · **Plan**: Free.
6. En "Environment Variables" agrega TODAS las variables de tu `.env` (las 3 de siempre, más `TELEGRAM_WEBHOOK_SECRET`, `GOOGLE_SHEETS_WEBHOOK_URL`, `GOOGLE_SHEETS_SECRETO`).
7. Click en "Create Web Service". Render te dará una URL pública tipo `https://tu-app.onrender.com`.

Apenas el servidor arranca en Render, **configura el webhook de Telegram
automáticamente solo** (usa la URL pública que Render te asigna). No
tenés que hacer nada manual para eso — vas a ver en los "Logs" de Render
una línea que dice "✅ Webhook de Telegram configurado en ...".

### ⚠️ Importante sobre el plan gratuito de Render

Los servicios gratuitos de Render se "duermen" tras 15 minutos sin
recibir tráfico, y al dormirse pierden lo que tengan en memoria y los
cambios en el disco (`database.json`), porque el sistema de archivos es
efímero. Usa un servicio gratuito de "ping" como
[UptimeRobot](https://uptimerobot.com) o [cron-job.org](https://cron-job.org)
para que visite tu URL cada 10 minutos y evite que se duerma. El
historial de Google Sheets no se ve afectado por esto — solo la
programación de partidos en curso.

## Cómo funciona ahora (resumen de la lógica)

- **4 puntos de chequeo por partido**: 24h, 6h, 1h y 5 minutos antes del inicio.
- En cada chequeo se piden, en una sola llamada (2 créditos: `alternate_totals` + `btts`, 1 región): las 3 líneas de goles (1.5/2.5/3.5) y el mercado BTTS. Costo total: **8 créditos por partido**.
- **Tendencia sostenida**: ya no se compara solo apertura vs. cierre. Se exige que la probabilidad implícita se haya movido en la misma dirección en los 3 intervalos (24h→6h→1h→5m), sin reversiones. Un salto grande pero errático NO dispara alerta.
- Se aplica esa misma exigencia de tendencia sostenida al **BTTS**, no solo al Over/Under.
- **La alerta OVER o UNDER solo se manda si las DOS cosas se cumplen a la vez**: el movimiento sostenido en la línea 2.5 (≥3 puntos porcentuales) Y una tendencia sostenida de BTTS que apunte en la misma dirección. Si falta cualquiera de las dos, el resultado es `⚠️ SIN APUESTA (Mercado Incierto)`. No hay niveles de confianza (ALTA/MEDIA/BAJA): solo OVER, UNDER, o SIN APUESTA.
- **60 partidos garantizados por mes**: si el ritmo de partidos analizados va atrasado respecto a la meta, el sistema sube automáticamente el máximo diario (de 4 hasta 6) para recuperar terreno. 60 partidos × 8 créditos = 480 créditos/mes, dentro del límite gratis de 500.
- **Selección de partidos**: mismas 13 ligas de antes (no se agregaron Colombia/Ecuador — no pude confirmar que The-Odds-API las cubra). Espacio mínimo entre partidos del mismo día: **2h30min** (antes 3h). Máximo normal: **4 partidos/día** (puede subir en "modo recuperación").

## Qué pasa con la tabla "en curso" de la web

Se borra, pero no apenas termina el partido: un partido queda visible en
la tabla de la web (y sigue "vivo" en el sistema) **hasta que le
contestás el marcador por Telegram**, porque hasta ese momento sigue
pendiente de resultado. Si nunca contestás, se da de baja solo a las
**48 horas**, para no quedar esperando para siempre. El **historial de
resultados** (el que alimenta el % de aciertos y la racha) es distinto:
ese vive en Google Sheets y no se borra nunca.

## Cómo funciona el marcador manual (sin gastar créditos)

1. Unas 3 horas después del inicio de cada partido (tiempo de sobra para que termine), el bot te manda un mensaje: "¿Cuál fue el marcador final de [equipos]?".
2. Vos le **respondés a ESE mensaje específico** (usando "Responder" en Telegram, no un mensaje suelto) con el resultado, por ejemplo `2-1`.
3. El bot identifica a qué partido corresponde por el mensaje al que respondiste (no se puede confundir aunque tengas varios partidos esperando marcador a la vez), calcula si tu predicción acertó, te confirma por Telegram, y lo guarda en tu hoja de Google Sheets.
4. Si escribís algo que no reconoce como marcador, el bot te avisa para que lo intentes de nuevo.

## Contador de aciertos y racha en la web

Arriba del botón vas a ver 3 números: % de aciertos (solo cuenta los
partidos donde SÍ hubo predicción OVER/UNDER, no los "sin apuesta"),
cantidad total de partidos analizados, y tu racha actual (positiva en
verde si venís de aciertos seguidos, en naranja si son fallos seguidos).
Estos datos se leen en vivo desde tu hoja de Google Sheets.

## Lista de archivos de este proyecto

- `server.js` — todo el backend.
- `public/index.html` — la web.
- `google-apps-script.js` — código para pegar en Google Sheets (no se despliega en Render, es para copiar y pegar).
- `.env.example` — plantilla de variables de entorno.
