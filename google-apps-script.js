/**
 * PEGAR ESTE CÓDIGO EN: Google Sheets → Extensiones → Apps Script
 *
 * Qué hace:
 * - POST: agrega una fila nueva al historial (llamado por tu bot cada vez
 *   que le contestás el marcador de un partido).
 * - GET: devuelve todo el historial en formato JSON (usado por la web
 *   para calcular el % de aciertos y la racha).
 *
 * Después de pegarlo:
 * 1. Cambiá SECRETO_COMPARTIDO por cualquier palabra/frase larga que
 *    vos inventes (debe ser IGUAL a la variable GOOGLE_SHEETS_SECRETO
 *    que pongas en Render).
 * 2. Arriba a la derecha: Implementar → Nueva implementación.
 * 3. Tipo: "Aplicación web". Ejecutar como: "Yo". Quién tiene acceso:
 *    "Cualquier usuario" (esto NO expone tu hoja completa a internet,
 *    solo permite que este script específico reciba llamadas — y de
 *    todas formas está protegido por el secreto del paso 1).
 * 4. Copiá la URL que te da ("URL de la aplicación web") y pegala como
 *    la variable GOOGLE_SHEETS_WEBHOOK_URL en Render.
 * 5. Cada vez que edites este código, tenés que volver a hacer
 *    "Implementar → Gestionar implementaciones → editar (lápiz) →
 *    Nueva versión" para que los cambios se apliquen.
 */

const SECRETO_COMPARTIDO = 'cambia-esto-por-algo-largo-y-unico';
const NOMBRE_HOJA = 'Historial';

function obtenerHoja() {
  const libro = SpreadsheetApp.getActiveSpreadsheet();
  let hoja = libro.getSheetByName(NOMBRE_HOJA);
  if (!hoja) {
    hoja = libro.insertSheet(NOMBRE_HOJA);
    hoja.appendRow(['fecha', 'liga', 'partido', 'linea', 'prediccion', 'golesTotales', 'marcador', 'acierto']);
  }
  return hoja;
}

function doPost(e) {
  try {
    const datos = JSON.parse(e.postData.contents);
    if (datos.secreto !== SECRETO_COMPARTIDO) {
      return respuestaJson({ ok: false, error: 'Secreto inválido' });
    }

    const hoja = obtenerHoja();
    hoja.appendRow([
      datos.fecha || new Date().toISOString(),
      datos.liga || '',
      datos.partido || '',
      datos.linea || '',
      datos.prediccion || '',
      datos.golesTotales !== undefined ? datos.golesTotales : '',
      datos.marcador || '',
      datos.acierto === true ? true : datos.acierto === false ? false : '',
    ]);

    return respuestaJson({ ok: true });
  } catch (err) {
    return respuestaJson({ ok: false, error: err.message });
  }
}

function doGet(e) {
  try {
    const secreto = e.parameter.secreto;
    if (secreto !== SECRETO_COMPARTIDO) {
      return respuestaJson({ ok: false, error: 'Secreto inválido' });
    }

    const hoja = obtenerHoja();
    const filas = hoja.getDataRange().getValues();
    const encabezados = filas[0];
    const historial = filas.slice(1).map((fila) => {
      const obj = {};
      encabezados.forEach((clave, i) => { obj[clave] = fila[i]; });
      // Normaliza acierto: en la hoja puede quedar como true/false o
      // vacío (string ''), lo pasamos a boolean/null explícito.
      obj.acierto = obj.acierto === true ? true : obj.acierto === false ? false : null;
      return obj;
    });

    return respuestaJson({ ok: true, historial });
  } catch (err) {
    return respuestaJson({ ok: false, error: err.message });
  }
}

function respuestaJson(objeto) {
  return ContentService.createTextOutput(JSON.stringify(objeto)).setMimeType(ContentService.MimeType.JSON);
}
