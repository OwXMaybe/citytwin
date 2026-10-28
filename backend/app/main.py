"""CityTwin API — FastAPI app factory.

    uvicorn app.main:app --reload --port 8000     (from backend/)
"""

import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import __version__
from .config import Settings, get_settings
from .db import create_pool, migrate
from .routers import ai, geo, proxy, sensors
from .services.agent import Agent
from .services.districts import load_all
from .services.sensors import SensorService
from .services.ws_hub import Hub
from .upstream import SingleFlight, TTLCache, make_client

log = logging.getLogger("citytwin")


class FrontendFiles(StaticFiles):
    """Built frontend. Vite's hashed assets are immutable; everything else (index.html)
    must be revalidated, or browsers keep an old index that points at deleted chunks."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        # path is normpath'd, so it uses backslashes on Windows
        if path.replace("\\", "/").startswith("assets/") and response.status_code in (200, 304):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "no-cache"
        return response


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.settings = settings
        app.state.pool = await create_pool(settings.database_url)
        await migrate(app.state.pool)
        loaded = await load_all(app.state.pool, settings.districts_dir)
        if loaded:
            log.info("district sets (re)loaded: %s", loaded)
        app.state.http = make_client()
        app.state.cache = TTLCache()
        app.state.flight = SingleFlight()
        app.state.hub = Hub()
        app.state.sensors = SensorService(app.state.pool, app.state.http, settings, app.state.hub)
        app.state.agent = Agent.from_settings(settings)
        poller = asyncio.create_task(app.state.sensors.run_forever()) if settings.poller_enabled else None
        try:
            yield
        finally:
            if poller:
                poller.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await poller
            await app.state.http.aclose()
            await app.state.pool.close()

    app = FastAPI(title="CityTwin API", version=__version__, lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_methods=["*"], allow_headers=["*"])

    @app.get("/api/v1/health", tags=["meta"])
    async def health(request: Request):
        pool = request.app.state.pool
        postgis = await pool.fetchval("SELECT postgis_lib_version()")
        districts = await pool.fetchval("SELECT count(*) FROM district")
        readings = await pool.fetchval("SELECT count(*) FROM reading")
        return {
            "ok": True,
            "version": __version__,
            "postgis": postgis,
            "districts": districts,
            "readings": readings,
            "openaq": bool(request.app.state.settings.openaq_api_key),
            "ai": request.app.state.agent.status(),
            "poller": {"enabled": request.app.state.settings.poller_enabled, "lastRun": request.app.state.sensors.last_run},
            "websocketClients": request.app.state.hub.count(),
            "cache": {"entries": len(request.app.state.cache), "hits": request.app.state.cache.hits, "misses": request.app.state.cache.misses},
        }

    app.include_router(geo.router)
    app.include_router(proxy.router)
    app.include_router(sensors.router)
    app.include_router(ai.router)

    # Single deployable: serve the built frontend (npm run build) when present.
    if settings.frontend_dist.is_dir():
        app.mount("/", FrontendFiles(directory=settings.frontend_dist, html=True), name="frontend")
    return app


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
app = create_app()
