// Convierte un .dwg a .dxf server-side usando LibreDWG (dwg2dxf), un
// binario estático (compilado sin dependencias del sistema, para no
// pisarse con la versión de glibc del runtime de Vercel) bundleado en
// api/bin/dwg2dxf. El DWG es un formato binario propietario de Autodesk
// sin especificación pública — no existe forma de leerlo client-side, así
// que la conversión pasa por acá y el navegador recibe el DXF resultante
// (que el visor ya sabe mostrar).

import { spawn } from "child_process";
import { mkdtemp, readFile, writeFile, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

const DWG2DXF_BIN = path.join(process.cwd(), "api", "bin", "dwg2dxf");
// Vercel tiene un límite DURO de ~4.5MB para el body de una Serverless
// Function — no es configurable. Mandando el archivo como base64 dentro
// de un JSON (en vez de bytes crudos con bodyParser:false, que es un
// patrón de Next.js y no se comportaba bien acá — se quedaba colgado
// "convirtiendo" para siempre porque el body nunca terminaba de leerse)
// se usa el parseo de JSON que trae Vercel por default, sin ambigüedad.
// Pero eso significa que el .dwg ORIGINAL tiene que entrar en ese límite
// una vez codificado en base64 (~33% más grande) — de ahí el tope acá.
const MAX_BYTES = 3 * 1024 * 1024; // ~3MB de DWG original ≈ 4MB en base64
const TIMEOUT_MS = 25000; // las funciones de Vercel tienen su propio límite de tiempo; cortamos antes

function ejecutarConTimeout(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("La conversión tardó demasiado (archivo muy complejo o corrupto)"));
    }, timeoutMs);
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `dwg2dxf terminó con código ${code}`));
    });
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido" });
    return;
  }

  let tmpDir;
  try {
    const archivoBase64 = req.body?.archivoBase64;
    if (!archivoBase64 || typeof archivoBase64 !== "string") {
      res.status(400).json({ error: "No se recibió ningún archivo" });
      return;
    }
    const buffer = Buffer.from(archivoBase64, "base64");
    if (!buffer.length) {
      res.status(400).json({ error: "El archivo llegó vacío" });
      return;
    }
    if (buffer.length > MAX_BYTES) {
      res.status(413).json({ error: `Archivo muy grande (máx ${Math.round(MAX_BYTES / 1024 / 1024)}MB — límite de Vercel para el tamaño del pedido)` });
      return;
    }

    tmpDir = await mkdtemp(path.join(tmpdir(), "dwg2dxf-"));
    const dwgPath = path.join(tmpDir, "entrada.dwg");
    const dxfPath = path.join(tmpDir, "salida.dxf");
    await writeFile(dwgPath, buffer);

    await ejecutarConTimeout(DWG2DXF_BIN, ["-y", "-o", dxfPath, dwgPath], TIMEOUT_MS);

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
