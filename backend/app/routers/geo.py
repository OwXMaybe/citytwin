from fastapi import APIRouter, HTTPException, Query, Request

from ..cities import CITIES
from ..services.districts import districts_feature_collection

router = APIRouter(prefix="/api/v1", tags=["geo"])


def _city(city_id: str) -> str:
    if city_id not in CITIES:
        raise HTTPException(404, f"Unknown city '{city_id}'")
    return city_id


@router.get("/cities")
async def list_cities(request: Request):
    rows = await request.app.state.pool.fetch(
        """SELECT c.id, c.name, c.country, c.timezone, ST_X(c.center) AS lon, ST_Y(c.center) AS lat,
                  count(d.id) AS districts,
                  round(coalesce(sum(ST_Area(d.geom::geography)), 0)::numeric / 1e6, 1)::float8 AS area_km2
           FROM city c LEFT JOIN district d ON d.city_id = c.id
           GROUP BY c.id ORDER BY c.name"""
    )
    return [dict(r) for r in rows]


@router.get("/cities/{city_id}/districts")
async def city_districts(city_id: str, request: Request):
    fc = await districts_feature_collection(request.app.state.pool, _city(city_id))
    if fc is None:
        raise HTTPException(404, f"No districts loaded for '{city_id}' — run `npm run import:districts` then `python -m app.cli load-districts`")
    return fc


@router.get("/cities/{city_id}/districts/at")
async def district_at(city_id: str, request: Request, lon: float = Query(ge=-180, le=180), lat: float = Query(ge=-90, le=90)):
    """Point-in-polygon via the PostGIS GiST index."""
    row = await request.app.state.pool.fetchrow(
        """SELECT osm_id, name, round((ST_Area(geom::geography) / 1e6)::numeric, 3)::float8 AS area_km2
           FROM district WHERE city_id = $1 AND ST_Intersects(geom, ST_SetSRID(ST_MakePoint($2, $3), 4326))
           LIMIT 1""",
        _city(city_id),
        lon,
        lat,
    )
    if not row:
        raise HTTPException(404, "Point is outside the loaded districts")
    return {"osmId": row["osm_id"], "name": row["name"], "areaKm2": row["area_km2"]}
