"""
Local static file server for UI/UX review — identical to `python -m http.server`
except every response is sent with Cache-Control: no-store, so the browser
never serves a stale cached copy of a JS/HTML file after an edit. Plain
http.server doesn't set this, which caused repeated stale-script confusion
during development (fresh page loads silently re-using old cached JS).
"""

import http.server


class NoCacheHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    http.server.test(HandlerClass=NoCacheHTTPRequestHandler, port=8080)
