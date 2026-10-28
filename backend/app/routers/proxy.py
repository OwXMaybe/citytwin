"""Cached upstream proxies: İBB (traffic + air), OpenAQ (key injected here) and Overpass."""

import hashlib
import logging
from datetime import timedelta

import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from ..upstream import CachedResponse, get_with_retry, lenient_get, pg_cache_get, pg_cache_set

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1", tags=["proxy"])

# name → (upstream base, L1 cache TTL seconds, needs lenient HTTP client)
PROXIES: dict[str, tuple[str, int, bool]] = {
    "ibb-traffic": ("https://api.ibb.gov.tr/tkmservices/api/TrafficData/v1", 60, True),  # duplicated Transfer-Encoding
    "ibb-air": ("https://api.ibb.gov.tr/havakalitesi/OpenDataPortalHandler", 600, False),
    "openaq": ("https://api.openaq.org", 300, False),
}

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
OVERPASS_TTL = timedelta(days=7)


@router.get("/proxy/{name}/{path:path}")
async def proxy(name: str, path: str, request: Request) -> Response:
    if name not in PROXIES:
        raise HTTPException(404, f"Unknown upstream '{name}'")
    if ".." in path or path.startswith("/"):
        raise HTTPException(400, "Invalid path")
    base, ttl, lenient = PROXIES[name]
    headers: dict[str, str] = {}
    if name == "openaq":
        key = request.app.state.settings.openaq_api_key
        if not key:
            raise HTTPException(503, "OPENAQ_API_KEY is not configured on the backend")
        headers["X-API-Key"] = key

    query = request.url.query
    cache_key = f"{name}:{path}?{query}"
    cache = request.app.state.cache
    if hit := cache.get(cache_key):
        return Response(hit.body, status_code=hit.status, media_type=hit.content_type, headers={"X-Cache": "HIT"})

    async with request.app.state.flight.lock(cache_key):
        if hit := cache.get(cache_key):  # filled while we waited
            return Response(hit.body, status_code=hit.status, media_type=hit.content_type, headers={"X-Cache": "HIT"})
        try:
            if lenient:
                resp = await lenient_get(f"{base}/{path}", params=request.query_params, headers=headers)
            else:
                resp = await get_with_retry(request.app.state.http, f"{base}/{path}", params=request.query_params, headers=headers)
        except (httpx.HTTPError, OSError) as e:
            raise HTTPException(502, f"Upstream {name} unreachable: {type(e).__name__}") from e
        ctype = resp.headers.get("content-type", "application/json").split(";")[0]
        if resp.status_code == 200:
            cache.set(cache_key, CachedResponse(resp.content, ctype), ttl)
        return Response(resp.content, status_code=resp.status_code, media_type=ctype, headers={"X-Cache": "MISS"})


class OverpassQuery(BaseModel):
    query: str = Field(min_length=10, max_length=20_000)


@router.post("/overpass")
async def overpass(body: OverpassQuery, request: Request) -> Response:
    """Overpass with mirror fallback and a durable 7-day PostGIS-backed cache."""
    q = body.query.strip()
    if not q.startswith("[out:json]"):
        raise HTTPException(400, "Only [out:json] queries are accepted")
    key = "overpass:" + hashlib.sha256(q.encode()).hexdigest()
    pool = request.app.state.pool
    if hit := await pg_cache_get(pool, key):
        cached, meta = hit
        return Response(cached.body, media_type=cached.content_type, headers={"X-Cache": "HIT", "X-Overpass-Endpoint": meta.get("endpoint", "")})

    async with request.app.state.flight.lock(key):
        if hit := await pg_cache_get(pool, key):
            cached, meta = hit
            return Response(cached.body, media_type=cached.content_type, headers={"X-Cache": "HIT", "X-Overpass-Endpoint": meta.get("endpoint", "")})
        errors: list[str] = []
        client: httpx.AsyncClient = request.app.state.http
        for endpoint in OVERPASS_ENDPOINTS:
            try:
                resp = await client.post(endpoint, data={"data": q}, timeout=httpx.Timeout(95.0, connect=10.0))
            except httpx.HTTPError as e:
                errors.append(f"{httpx.URL(endpoint).host}: {type(e).__name__}")
                continue
            text = resp.text.lstrip()
            if resp.status_code != 200 or not text.startswith("{") or '"remark": "runtime error' in text[:4000]:
                errors.append(f"{httpx.URL(endpoint).host}: HTTP {resp.status_code}")
                continue
            host = httpx.URL(endpoint).host
            await pg_cache_set(pool, key, CachedResponse(resp.content, "application/json"), OVERPASS_TTL, {"endpoint": host})
            return Response(resp.content, media_type="application/json", headers={"X-Cache": "MISS", "X-Overpass-Endpoint": host})
        raise HTTPException(503, f"All Overpass servers are busy or unreachable ({'; '.join(errors[-3:])})")
