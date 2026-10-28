"""Shared outbound HTTP client and caches for upstream data providers."""

import asyncio
import time
import urllib.error
import urllib.request
from collections import OrderedDict
from dataclasses import dataclass
from datetime import timedelta

import asyncpg
import httpx

from . import __version__

USER_AGENT = f"CityTwin/{__version__} (+https://github.com/; urban digital twin backend)"


def make_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=httpx.Timeout(45.0, connect=10.0),
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        follow_redirects=True,
        limits=httpx.Limits(max_connections=40, max_keepalive_connections=20),
    )


async def get_with_retry(client: httpx.AsyncClient, url: str, *, retries: int = 2, **kw) -> httpx.Response:
    """GET with retries on network errors and 5xx (not on 4xx)."""
    delay = 1.0
    for attempt in range(retries + 1):
        try:
            resp = await client.get(url, **kw)
            if resp.status_code < 500 or attempt == retries:
                return resp
        except httpx.TransportError:
            if attempt == retries:
                raise
        await asyncio.sleep(delay)
        delay *= 2
    raise RuntimeError("unreachable")


def _urllib_get(url: str, headers: dict[str, str], timeout: float) -> httpx.Response:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body, status, ctype = r.read(), r.status, r.headers.get("Content-Type", "application/json")
    except urllib.error.HTTPError as e:
        body, status, ctype = e.read(), e.code, e.headers.get("Content-Type", "text/plain")
    # Some servers label JSON as XML; trust the body.
    if body.lstrip()[:1] in (b"{", b"["):
        ctype = "application/json"
    return httpx.Response(status, content=body, headers={"content-type": ctype})


async def lenient_get(url: str, *, params=None, headers: dict[str, str] | None = None, timeout: float = 45.0) -> httpx.Response:
    """Fallback for upstreams that violate HTTP/1.1 framing (e.g. duplicated Transfer-Encoding),
    which httpx/h11 rightly reject but browsers and urllib tolerate. Runs in a worker thread."""
    full = str(httpx.URL(url, params=params)) if params else url
    return await asyncio.to_thread(_urllib_get, full, headers or {}, timeout)


@dataclass
class CachedResponse:
    body: bytes
    content_type: str
    status: int = 200


class TTLCache:
    """Small in-process LRU cache with per-entry TTL (L1 for proxy responses)."""

    def __init__(self, max_entries: int = 2000):
        self._data: OrderedDict[str, tuple[float, CachedResponse]] = OrderedDict()
        self._max = max_entries
        self.hits = 0
        self.misses = 0

    def get(self, key: str) -> CachedResponse | None:
        item = self._data.get(key)
        if not item or item[0] < time.monotonic():
            self._data.pop(key, None)
            self.misses += 1
            return None
        self._data.move_to_end(key)
        self.hits += 1
        return item[1]

    def set(self, key: str, value: CachedResponse, ttl_s: float) -> None:
        self._data[key] = (time.monotonic() + ttl_s, value)
        self._data.move_to_end(key)
        while len(self._data) > self._max:
            self._data.popitem(last=False)

    def __len__(self) -> int:
        return len(self._data)


async def pg_cache_get(pool: asyncpg.Pool, key: str) -> tuple[CachedResponse, dict] | None:
    row = await pool.fetchrow("SELECT body, content_type, meta FROM http_cache WHERE key = $1 AND expires_at > now()", key)
    return (CachedResponse(bytes(row["body"]), row["content_type"]), row["meta"]) if row else None


async def pg_cache_set(pool: asyncpg.Pool, key: str, value: CachedResponse, ttl: timedelta, meta: dict | None = None) -> None:
    await pool.execute(
        """INSERT INTO http_cache (key, body, content_type, stored_at, expires_at, meta)
           VALUES ($1, $2, $3, now(), now() + $4::interval, $5)
           ON CONFLICT (key) DO UPDATE SET body = EXCLUDED.body, content_type = EXCLUDED.content_type,
             stored_at = now(), expires_at = EXCLUDED.expires_at, meta = EXCLUDED.meta""",
        key,
        value.body,
        value.content_type,
        ttl,
        meta or {},
    )


class SingleFlight:
    """Collapses concurrent identical upstream requests into one."""

    def __init__(self) -> None:
        self._locks: dict[str, asyncio.Lock] = {}

    def lock(self, key: str) -> asyncio.Lock:
        return self._locks.setdefault(key, asyncio.Lock())
