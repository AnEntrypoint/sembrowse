from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .engine import SemIfEngine


def question_options(criteria: dict[str, Any]) -> list[dict[str, str]]:
    return [{"id": key, "description": json.dumps(value, ensure_ascii=False, sort_keys=True) if not isinstance(value, str) else value} for key, value in criteria.items()]


class Service(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], engine: SemIfEngine):
        super().__init__(address, Handler)
        self.engine = engine


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def respond(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.end_headers()

    def do_GET(self) -> None:
        if self.path == "/health":
            self.respond(200, {"status": "ready", "model": self.server.engine.metadata})
            return
        self.respond(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/v1/choose":
            self.respond(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 2_000_000:
                raise ValueError("request body must be between 1 and 2000000 bytes")
            request = json.loads(self.rfile.read(length))
            state = request["state"]
            answers = {}
            for question_id, question in request["questions"].items():
                options = question_options(question["criteria"])
                answer = (
                    {"choice": options[0]["id"], "probabilities": {options[0]["id"]: 1.0}, "confidence": 1.0}
                    if len(options) == 1
                    else self.server.engine.choose(
                        state, json.dumps(question.get("instructions", {}), ensure_ascii=False), options, question_id
                    )
                )
                answers[question_id] = {key: answer[key] for key in ("choice", "probabilities", "confidence")}
            self.respond(200, {"answers": answers, "model": self.server.engine.metadata})
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            self.respond(400, {"error": str(error)})

    def log_message(self, *_: Any) -> None:
        return


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--dtype", default="bfloat16")
    parser.add_argument("--port", default=8787, type=int)
    arguments = parser.parse_args()
    service = Service(("127.0.0.1", arguments.port), SemIfEngine(arguments.model, arguments.revision, arguments.device, arguments.dtype))
    print(f"Sembrowse local service listening at http://127.0.0.1:{arguments.port}", flush=True)
    service.serve_forever()
