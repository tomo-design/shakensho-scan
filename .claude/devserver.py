"""UI確認用のローカル静的サーバー(キャッシュ無効)。
   ブラウザやService Workerが古いapp.js/style.cssを掴んで
   変更が反映されない問題を避けるため、常に no-store を返す。"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):  # アクセスログは静かに
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print("serving (no-store) on http://localhost:%d" % port, flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), NoCacheHandler).serve_forever()
