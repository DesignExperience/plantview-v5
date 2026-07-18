// Proxy server-side para descargar contenido de Google Drive (alt=media).
//
// Por qué existe: el endpoint de descarga de contenido de Drive
// (files.get con alt=media) no envía headers CORS para pedidos hechos
// directo desde el navegador, aunque sí los envía para listar/metadata.
// Un pedido servidor-a-servidor (esta función) no está sujeto a CORS,
// así que el navegador le pide el archivo a ESTE endpoint (mismo origen)
// y este endpoint es quien le habla a Google.
//
// La API Key la sigue proveyendo el cliente (cada usuario puede conectar
// su propia carpeta/key vía el modal de Drive) — este proxy no la fija
// ni la esconde, solo evita el bloqueo de CORS en la descarga.

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Método no permitido" });
    return;
  }

  const { fileId, key } = req.query;

  if (!fileId || !key) {
    res.status(400).json({ error: "Faltan parámetros: fileId y key son obligatorios" });
    return;
  }
  // Los IDs de archivo de Drive son alfanuméricos + guiones/underscores.
  if (!/^[a-zA-Z0-9_-]+$/.test(fileId)) {
    res.status(400).json({ error: "fileId inválido" });
    return;
  }

  try {
    const driveUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&key=${encodeURIComponent(key)}`;
    const driveResp = await fetch(driveUrl);

    if (!driveResp.ok) {
      let mensaje = `Drive respondió HTTP ${driveResp.status}`;
      try {
        const cuerpo = await driveResp.json();
        if (cuerpo?.error?.message) mensaje = cuerpo.error.message;
      } catch (e) {}
      res.status(driveResp.status).json({ error: mensaje });
      return;
    }

    const buffer = Buffer.from(await driveResp.arrayBuffer());
    const contentType = driveResp.headers.get("content-type") || "application/octet-stream";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.status(200).send(buffer);
  } catch (err) {
    console.error("Error en drive-proxy:", err);
    res.status(502).json({ error: "No se pudo descargar el archivo desde Drive: " + err.message });
  }
}
