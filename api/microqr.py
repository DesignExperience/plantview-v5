# Genera la matriz de módulos de un Micro QR usando segno (librería Python
# madura, con años de testing) en vez de reimplementar el encoder a mano en
# JS — mismo criterio que usamos para DWG con LibreDWG: si existe una
# implementación probada de un formato con muchos detalles finos donde es
# fácil introducir bugs sutiles, se usa esa en vez de escribir una nueva.
#
# No existe una librería JS confiable para GENERAR Micro QR (verificado:
# ni qrcode-generator ni ninguna otra opción común lo soporta) — para
# LEERLO de vuelta y verificar sí existe (@zxing/library, client-side).

import json
import segno
from http.server import BaseHTTPRequestHandler


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            data = json.loads(body or b"{}")
            texto = data.get("texto", "")
            if not texto:
                self._responder(400, {"error": 'Falta "texto"'})
                return

            # M4 + nivel Q (el máximo disponible en Micro QR — no existe H
            # ahí) a propósito, en vez del auto-boost al más chico posible:
            # nuestros códigos de 6 caracteres entran en M2 con nivel L
            # (~7%, poquísimo margen), pero necesitamos ese margen para
            # absorber los puentes del calado — mismo criterio que con el
            # QR normal (ahí también priorizamos margen de corrección por
            # sobre el tamaño mínimo posible).
            try:
                qr = segno.make(texto, micro=True, version="M4", error="Q")
            except Exception:
                qr = segno.make(texto, micro=True, boost_error=True)
            matriz = [[bool(v) for v in fila] for fila in qr.matrix]

            self._responder(200, {
                "matriz": matriz,
                "version": qr.version,
                "error": qr.error,
                "mask": qr.mask,
            })
        except Exception as err:
            self._responder(422, {"error": "No se pudo generar el Micro QR: " + str(err)})

    def _responder(self, codigo, payload):
        cuerpo = json.dumps(payload).encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(cuerpo)
