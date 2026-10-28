"""Loads the OSM district pipeline output (public/data/districts/*.geojson) into PostGIS."""

import json
import logging
from datetime import datetime
from pathlib import Path

import asyncpg

from ..cities import CITIES

log = logging.getLogger(__name__)


def _ts(v: str | None) -> datetime | None:
    return datetime.fromisoformat(v.replace("Z", "+00:00")) if v else None


async def load_city_file(pool: asyncpg.Pool, path: Path, *, force: bool = False) -> int | None:
    """Replace one city's districts from a pipeline file. Returns rows loaded, or None if unchanged."""
    fc = json.loads(path.read_text(encoding="utf-8"))
    meta = fc["metadata"]
    city_id = meta["cityId"]
    if city_id not in CITIES:
        log.warning("skipping %s: unknown city %s", path.name, city_id)
        return None
    imported_at = _ts(meta["importedAt"])
    async with pool.acquire() as conn:
        current = await conn.fetchval("SELECT imported_at FROM district_import WHERE city_id = $1", city_id)
        if current == imported_at and not force:
            return None
        async with conn.transaction():
            await conn.execute("DELETE FROM district WHERE city_id = $1", city_id)
            await conn.executemany(
                """INSERT INTO district (city_id, osm_id, name, name_en, population, population_date, wikidata, geom)
                   VALUES ($1, $2, $3, $4, $5, $6, $7,
                           ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($8), 4326)), 3)))""",
                [
                    (
                        city_id,
                        f["properties"]["osmId"],
                        f["properties"]["name"],
                        f["properties"].get("nameEn"),
                        f["properties"].get("population"),
                        f["properties"].get("populationDate"),
                        f["properties"].get("wikidata"),
                        json.dumps(f["geometry"]),
                    )
                    for f in fc["features"]
                ],
            )
            await conn.execute(
                """INSERT INTO district_import (city_id, source, unit, admin_level, osm_timestamp, imported_at, simplified_tolerance_m, loaded_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, now())
                   ON CONFLICT (city_id) DO UPDATE SET source = EXCLUDED.source, unit = EXCLUDED.unit,
                     admin_level = EXCLUDED.admin_level, osm_timestamp = EXCLUDED.osm_timestamp,
                     imported_at = EXCLUDED.imported_at, simplified_tolerance_m = EXCLUDED.simplified_tolerance_m,
                     loaded_at = now()""",
                city_id,
                meta["source"],
                meta["unit"],
                meta["adminLevel"],
                _ts(meta.get("osmTimestamp")),
                imported_at,
                meta.get("simplifiedToleranceM"),
            )
    log.info("loaded %d districts for %s", len(fc["features"]), city_id)
    return len(fc["features"])


async def load_all(pool: asyncpg.Pool, directory: Path, *, force: bool = False) -> dict[str, int]:
    loaded: dict[str, int] = {}
    if not directory.exists():
        log.warning("district directory %s not found — run `npm run import:districts`", directory)
        return loaded
    for path in sorted(directory.glob("*.geojson")):
        n = await load_city_file(pool, path, force=force)
        if n is not None:
            loaded[path.stem] = n
    return loaded


async def districts_feature_collection(pool: asyncpg.Pool, city_id: str) -> dict | None:
    """Same shape as the pipeline file (DistrictCollection), but computed by PostGIS."""
    async with pool.acquire() as conn:
        meta = await conn.fetchrow("SELECT * FROM district_import WHERE city_id = $1", city_id)
        if not meta:
            return None
        rows = await conn.fetch(
            """SELECT osm_id, name, name_en, population, population_date, wikidata,
                      ST_AsGeoJSON(geom, 5)::json AS geometry,
                      round((ST_Area(geom::geography) / 1e6)::numeric, 3)::float8 AS area_km2,
                      ST_X(ST_PointOnSurface(geom)) AS cx, ST_Y(ST_PointOnSurface(geom)) AS cy
               FROM district WHERE city_id = $1 ORDER BY name""",
            city_id,
        )
    return {
        "type": "FeatureCollection",
        "metadata": {
            "cityId": city_id,
            "source": meta["source"],
            "unit": meta["unit"],
            "adminLevel": meta["admin_level"],
            "osmTimestamp": meta["osm_timestamp"].isoformat() if meta["osm_timestamp"] else None,
            "importedAt": meta["imported_at"].isoformat(),
            "simplifiedToleranceM": meta["simplified_tolerance_m"],
            "servedBy": "PostGIS",
        },
        "features": [
            {
                "type": "Feature",
                "id": r["osm_id"],
                "geometry": r["geometry"],
                "properties": {
                    "osmId": r["osm_id"],
                    "name": r["name"],
                    "nameEn": r["name_en"],
                    "population": r["population"],
                    "populationDate": r["population_date"],
                    "wikidata": r["wikidata"],
                    "areaKm2": r["area_km2"],
                    "center": [round(r["cx"], 5), round(r["cy"], 5)],
                },
            }
            for r in rows
        ],
    }
