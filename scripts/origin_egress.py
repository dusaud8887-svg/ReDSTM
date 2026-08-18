from __future__ import annotations

import argparse
import select
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from crawler.origin_proxy import TYPEMOON_ORIGIN_HOSTS


class _ConnectHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_CONNECT(self) -> None:
        host, _, port_text = self.path.partition(":")
        try:
            port = int(port_text or "443")
        except ValueError:
            self.send_error(400, "invalid CONNECT target")
            return
        if host not in TYPEMOON_ORIGIN_HOSTS or port not in {80, 443}:
            self.send_error(403, "host not allowed")
            return
        try:
            remote = socket.create_connection((host, port), timeout=15)
        except OSError:
            self.send_error(502, "origin connect failed")
            return
        self.send_response(200, "Connection Established")
        self.end_headers()
        sockets = [self.connection, remote]
        try:
            while True:
                readable, _, _ = select.select(sockets, [], [], 60)
                if not readable:
                    break
                for source in readable:
                    data = source.recv(65536)
                    if not data:
                        return
                    destination = remote if source is self.connection else self.connection
                    destination.sendall(data)
        finally:
            remote.close()

    def log_message(self, format: str, *args: object) -> None:
        return


def serve_origin_egress(host: str, port: int) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), _ConnectHandler)


def main() -> None:
    parser = argparse.ArgumentParser(description="TypeMoon-only HTTP CONNECT egress.")
    parser.add_argument("--listen", default="127.0.0.1:18080")
    args = parser.parse_args()
    host, _, port_text = args.listen.rpartition(":")
    server = serve_origin_egress(host or "127.0.0.1", int(port_text))
    server.serve_forever()


if __name__ == "__main__":
    main()
