"""Static dev server for the web/ folder.

Same as `python -m http.server`, plus two fixes that matter for this app:
  * Forces correct MIME types. On Windows, Python reads them from the registry,
    which can report .js as text/plain or leave .wasm unknown; the browser then
    refuses the module or falls back to slower Wasm loading.
  * Sends no-cache headers, so a rebuild shows up on a normal reload.

Usage: python serve.py [port]   (default 8080)
"""

import functools
import http.server
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "web"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".wasm": "application/wasm",
        ".wgsl": "text/plain",
        ".png": "image/png",
        ".svg": "image/svg+xml",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    if not (ROOT / "libs" / "fractal" / "fractal_explorer_bg.wasm").exists():
        print("Warning: web/libs/fractal is missing. Run the build script first.\n")
    handler = functools.partial(Handler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler) as httpd:
        print(f"Serving {ROOT} at http://localhost:{PORT}  (Ctrl+C to stop)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
