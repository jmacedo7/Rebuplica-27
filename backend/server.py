"""FastAPI proxy that forwards all /api/* requests to the Node backend.

Supervisor expects a FastAPI app at /app/backend/server.py on port 8001 and the
whole architecture of the Emergent platform routes `/api/*` traffic to that
port. The real Rebuplica 27 server is a native TypeScript HTTP server that
listens on localhost:8002; this thin proxy transparently forwards every
request, preserving headers, method, body, query, status code and response
body (streaming).
"""
from __future__ import annotations

import os

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware

NODE_BACKEND_URL = os.environ.get("NODE_BACKEND_URL", "http://127.0.0.1:8002")

app = FastAPI(title="Rebuplica 27 API Proxy")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["x-request-id", "x-ratelimit-limit", "x-ratelimit-remaining", "retry-after"],
)

_client: httpx.AsyncClient | None = None


@app.on_event("startup")
async def startup() -> None:
    global _client
    _client = httpx.AsyncClient(base_url=NODE_BACKEND_URL, timeout=httpx.Timeout(60.0))


@app.on_event("shutdown")
async def shutdown() -> None:
    if _client is not None:
        await _client.aclose()


HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
}


def _forwardable_headers(request: Request) -> dict:
    """Headers to forward upstream.

    The browser-facing CORS decision belongs to the edge (this proxy), not to the Node
    server: behind the ingress the Node process only ever sees a localhost peer, so its
    own origin allowlist cannot be configured per environment. `Origin` is therefore
    dropped before forwarding. Cross-site requests are still safe because the session
    cookie is `SameSite=Lax` and the JWT is never sent automatically.
    """
    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_BY_HOP}
    headers.pop("origin", None)
    return headers


@app.get("/api/healthz")
async def healthz() -> dict:
    return {"status": "ok", "proxy": "fastapi", "backend": NODE_BACKEND_URL}


@app.api_route(
    "/api/{path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
)
async def proxy(path: str, request: Request) -> Response:
    assert _client is not None
    body = await request.body()
    forward_headers = _forwardable_headers(request)
    url = f"/api/{path}"
    if request.url.query:
        url = f"{url}?{request.url.query}"
    try:
        upstream = await _client.request(
            request.method,
            url,
            headers=forward_headers,
            content=body if body else None,
        )
    except httpx.ConnectError:
        return Response(
            content=b'{"error":{"code":"BACKEND_UNAVAILABLE","message":"Node backend is not reachable"}}',
            status_code=503,
            media_type="application/json",
        )

    response_headers = {
        k: v for k, v in upstream.headers.items() if k.lower() not in HOP_BY_HOP
    }
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=response_headers,
    )
