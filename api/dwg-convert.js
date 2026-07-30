// Convierte un .dwg a .dxf server-side usando LibreDWG (dwg2dxf), un
// binario estático (compilado sin dependencias del sistema, para no
// pisarse con la versión de glibc del runtime de Vercel) bundleado en
// api/bin/dwg2dxf. El DWG es un formato binario propietario de Autodesk
// sin especificación pública — no existe forma de leerlo client-side, así
// que la conversión pasa por acá y el navegador recibe el DXF resultante
// (que el visor ya sabe mostrar).
//
// Dos formas de entregar el archivo:
//  - driveFileId + driveApiKey: el servidor lo DESCARGA directo de Drive.
//    Evita por completo el límite de ~4.5MB que Vercel impone al body de
//    un POST — esa restricción es solo para lo que el cliente SUBE, no
//    para lo que el servidor descarga de otra API. Es el camino para
//    archivos grandes (probado con uno de ~218MB).
//  - archivoBase64: el archivo ya en memoria del cliente (ej. elegido desde
//    el filesystem local, sin pasar por Drive) — sigue atado al límite de
//    ~3MB de Vercel, no hay forma de evitarlo en ese caso.

import { spawn } from "child_process";
import { mkdtemp, readFile, writeFile, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

const DWG2DXF_BIN = path.join(process.cwd(), "api", "bin", "dwg2dxf");
const MAX_BYTES_BASE64 = 3 * 1024 * 1024; // límite duro de Vercel para el body de un POST (~4.5MB), con margen para el ~33% que infla base64
const MAX_BYTES_DRIVE = 300 * 1024 * 1024; // generoso, pero acotado — evita que un archivo absurdo tire abajo la función por memoria
const TIMEOUT_MS = 55000; // las funciones de Vercel tienen su propio límite de tiempo (ver vercel.json maxDuration); cortamos un poco antes

function ejecutarConTimeout(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("La conversión tardó demasiado (archivo muy grande, muy complejo, o corrupto)"));
    }, timeoutMs);
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `dwg2dxf terminó con código ${code}`));
    });
  });
}

// Descarga el DWG directo de Drive, server-side — nunca pasa por el body
// del POST del cliente, así que no está sujeto al límite de ~4.5MB.
async function descargarDwgDeDrive(fileId, apiKey) {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    let msg = `Drive respondió HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      if (j?.error?.message) msg = j.error.message;
    } catch (e) {}
    throw new Error("No se pudo descargar el DWG desde Drive: " + msg);
  }
  const len = parseInt(resp.headers.get("content-length") || "0", 10);
  if (len && len > MAX_BYTES_DRIVE) {
    throw new Error(`Archivo muy grande (${Math.round(len / 1024 / 1024)}MB, máx ${Math.round(MAX_BYTES_DRIVE / 1024 / 1024)}MB)`);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.length > MAX_BYTES_DRIVE) {
    throw new Error(`Archivo muy grande (${Math.round(buffer.length / 1024 / 1024)}MB, máx ${Math.round(MAX_BYTES_DRIVE / 1024 / 1024)}MB)`);
  }
  return buffer;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido" });
    return;
  }

  let tmpDir;
  try {
    const { archivoBase64, driveFileId, driveApiKey } = req.body || {};

    let buffer;
    if (driveFileId && driveApiKey) {
      buffer = await descargarDwgDeDrive(driveFileId, driveApiKey);
    } else if (archivoBase64 && typeof archivoBase64 === "string") {
      buffer = Buffer.from(archivoBase64, "base64");
      if (buffer.length > MAX_BYTES_BASE64) {
        res.status(413).json({ error: `Archivo muy grande (máx ${Math.round(MAX_BYTES_BASE64 / 1024 / 1024)}MB por este camino — límite de Vercel para el tamaño del pedido)` });
        return;
      }
    } else {
      res.status(400).json({ error: "No se recibió ningún archivo" });
      return;
    }

    if (!buffer.length) {
      res.status(400).json({ error: "El archivo llegó vacío" });
      return;
    }

    tmpDir = await mkdtemp(path.join(tmpdir(), "dwg2dxf-"));
    const dwgPath = path.join(tmpDir, "entrada.dwg");
    const dxfPath = path.join(tmpDir, "salida.dxf");
    await writeFile(dwgPath, buffer);

    // -m/--minimal: exporta solo $ACADVER, HANDSEED y ENTITIES, sin tablas de
    // capas/estilos/bloques — el visor solo lee entidades, así que esto es
    // puro peso muerto para nosotros. En archivos grandes reduce bastante el
    // tamaño del DXF resultante (menos para transferir y parsear) y acorta
    // el tiempo de conversión, ayudando a entrar en el límite de tiempo de
    // la función serverless.
    await ejecutarConTimeout(DWG2DXF_BIN, ["-y", "-m", "-o", dxfPath, dwgPath], TIMEOUT_MS);

    const info = await stat(dxfPath).catch(() => null);
    if (!info || info.size === 0) {
      throw new Error("La conversión no generó ningún archivo DXF");
    }

    const dxf = await readFile(dxfPath);
    res.setHeader("Content-Type", "application/dxf");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(dxf);
  } catch (err) {
    console.error("Error en dwg-convert:", err);
    // LibreDWG no lee el 100% de los DWG (formato propietario, ingeniería
    // inversa) — un archivo puntual puede fallar sin que sea un bug de acá.
    res.status(422).json({ error: "No se pudo convertir el DWG: " + (err.message || String(err)) });
  } finally {
    if (tmpDir) rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
