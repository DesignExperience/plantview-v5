// "Buscar o crear" la carpeta única "<glb> - Documentos y notas" de un
// modelo, con autocorrección de duplicados — server-side.
//
// Por qué existe: cada navegador (uno por usuario) le pegaba directo a la
// API de Drive para esto (obtenerOCrearCarpetaDrive, en index.html):
// "buscar por nombre, si no existe crear". Esas dos operaciones no son
// atómicas — si DOS USUARIOS DISTINTOS piden la misma carpeta casi al
// mismo tiempo (ej. cada uno guarda una nota en el mismo modelo, que
// todavía no tiene carpeta), los dos ven "no existe" antes de que el
// primero termine de crearla, y cada uno crea la suya — carpetas
// duplicadas, cada una con el content de un usuario distinto (confirmado
// en Drive: "Propietario" distinto en cada duplicada).
//
// Un caché en memoria del lado del navegador (ya existe, ver
// carpetaDriveEnVuelo en index.html) NO puede evitar esto: vive en la
// pestaña de CADA usuario por separado, no hay memoria compartida entre
// navegadores distintos sin pasar por un servidor.
//
// Esta función no logra exclusión mutua perfecta (Vercel puede correr
// cada pedido en una instancia serverless distinta, sin memoria
// compartida entre sí, así que dos pedidos simultáneos todavía pueden
// pisarse en la ventana entre buscar y crear) — pero cierra el caso real
// de la enorme mayoría de las carreras: apenas crea una carpeta, vuelve a
// buscar de inmediato: si en ese instante ya hay más de una (la carrera
// SÍ ocurrió), fusiona ahí mismo las duplicadas (mueve el contenido de
// las más nuevas a la más vieja y las manda a la papelera) ANTES de
// responderle al cliente — así el usuario nunca llega a ver el duplicado,
// se autocorrige en el mismo pedido en vez de acumularse.
//
// El token de escritura lo sigue mandando el navegador (mismo login de
// Drive de siempre, scope drive.file) — este endpoint no fija ni
// almacena ningún secreto propio, solo sirve de punto único de entrada
// para serializar/autocorregir esta operación puntual.

function escaparNombreDrive(nombre) {
  return nombre.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function driveFetch(url, token, opciones = {}) {
  const resp = await fetch(url, {
    ...opciones,
    headers: { Authorization: `Bearer ${token}`, ...(opciones.headers || {}) },
  });
  if (!resp.ok) {
    let mensaje = `Drive respondió HTTP ${resp.status}`;
    try {
      const cuerpo = await resp.json();
      if (cuerpo?.error?.message) mensaje = cuerpo.error.message;
    } catch (e) {}
    const err = new Error(mensaje);
    err.status = resp.status;
    throw err;
  }
  return resp.status === 204 ? null : resp.json();
}

async function buscarCarpetas(nombre, carpetaPadreId, token) {
  const q = encodeURIComponent(
    `name='${escaparNombreDrive(nombre)}' and '${carpetaPadreId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const data = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,createdTime)&orderBy=createdTime`,
    token
  );
  return data.files || [];
}

async function crearCarpeta(nombre, carpetaPadreId, token) {
  const data = await driveFetch("https://www.googleapis.com/drive/v3/files", token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: nombre, mimeType: "application/vnd.google-apps.folder", parents: [carpetaPadreId] }),
  });
  return data.id;
}

// Mueve todo el contenido de las carpetas duplicadas más nuevas a la más
// vieja (ya vienen ordenadas por createdTime) y manda las vacías
// resultantes a la papelera — mismo criterio que ya usa el cliente
// (fusionarGrupoCarpetasDrive, en index.html) para la limpieza manual.
async function fusionarDuplicadas(carpetas, token) {
  const [destino, ...duplicadas] = carpetas;
  for (const dup of duplicadas) {
    const hijos = await driveFetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${dup.id}' in parents and trashed=false`)}&fields=files(id)`,
      token
    );
    for (const hijo of hijos.files || []) {
      await driveFetch(
        `https://www.googleapis.com/drive/v3/files/${hijo.id}?addParents=${destino.id}&removeParents=${dup.id}`,
        token,
        { method: "PATCH" }
      );
    }
    await driveFetch(`https://www.googleapis.com/drive/v3/files/${dup.id}`, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    });
  }
  return destino.id;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido" });
    return;
  }

  const { nombre, carpetaPadreId, accessToken } = req.body || {};
  if (!nombre || !carpetaPadreId || !accessToken) {
    res.status(400).json({ error: "Faltan parámetros: nombre, carpetaPadreId y accessToken son obligatorios" });
    return;
  }

  try {
    let carpetas = await buscarCarpetas(nombre, carpetaPadreId, accessToken);

    if (carpetas.length === 0) {
      await crearCarpeta(nombre, carpetaPadreId, accessToken);
      // Recién creada acá, pero puede que YA exista otra creada por otro
      // usuario en el mismo instante (la carrera real) — se vuelve a
      // buscar de inmediato para detectarlo antes de responder.
      carpetas = await buscarCarpetas(nombre, carpetaPadreId, accessToken);
    }

    const folderId = carpetas.length > 1
      ? await fusionarDuplicadas(carpetas, accessToken)
      : carpetas[0].id;

    res.status(200).json({ carpetaId: folderId, fusionadas: Math.max(carpetas.length - 1, 0) });
  } catch (err) {
    console.error("Error en carpeta-notas:", err);
    res.status(err.status || 502).json({ error: err.message || "No se pudo resolver la carpeta en Drive" });
  }
}
