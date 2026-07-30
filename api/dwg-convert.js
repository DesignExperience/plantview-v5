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

export const config = {
  api: { bodyParser: false },
};

const DWG2DXF_BIN = path.join(process.cwd(), "api", "bin", "dwg2dxf");
const MAX_BYTES = 60 * 1024 * 1024; // 60MB — generoso para un plano, sin abrir la puerta a abusos
const TIMEOUT_MS = 25000; // las funciones de Vercel tienen su propio límite de tiempo; cortamos antes

async function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BYTES) {
        reject(new Error("Archivo muy grande (máx 60MB)"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

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
    const buffer = await leerCuerpo(req);
    if (!buffer.length) {
      res.status(400).json({ error: "No se recibió ningún archivo" });
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
