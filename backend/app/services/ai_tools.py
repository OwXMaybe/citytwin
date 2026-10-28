"""Tools CityTwin AI can call. Each one is read-only and returns JSON with provenance.

They query the same PostGIS tables and cached feeds the REST API serves, so the model
sees exactly what the dashboard can show, and nothing it cannot back with a source.
"""

import json
import logging
import time
from datetime import datetime, timezone
from statistics import median
from typing import Any, Awaitable, Callable
from zoneinfo import ZoneInfo

from ..cities import CITIES
from ..upstream import get_with_retry, lenient_get
from . import anomalies

log = logging.getLogger(__name__)

POLLUTANT_ENUM = ["pm25", "pm10", "no2", "o3", "so2", "co"]
HISTORY_POLLUTANTS = ["pm25", "pm10", "no2"]
CITY_PROP = {"type": "string", "enum": list(CITIES), "description": "City id"}
MAX_RESULT_CHARS = 24_000


def _tool(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {
        "name": name,
        "description": description,
        # Inputs are small, but streaming them as generated keeps the UI's "calling …" chip prompt.
        "eager_input_streaming": True,
        "input_schema": {"type": "object", "properties": properties, "required": required, "additionalProperties": False},
    }


TOOLS: list[dict] = [
    _tool("get_city_overview",
          "Snapshot of one city: district count and area, the latest ground-station network medians per pollutant, "
          "which air-quality providers are reporting, anomaly counts, and which dashboard modules are simulated. Start here for broad questions.",
          {"city": CITY_PROP}, ["city"]),
    _tool("list_districts",
          "Districts (OSM administrative boundaries in PostGIS) with geodesic area and the OSM population tag where one exists.",
          {"city": CITY_PROP}, ["city"]),
    _tool("find_district", "Which district contains a coordinate (PostGIS point-in-polygon).",
          {"city": CITY_PROP, "lon": {"type": "number", "minimum": -180, "maximum": 180}, "lat": {"type": "number", "minimum": -90, "maximum": 90}},
          ["city", "lon", "lat"]),
    _tool("get_air_stations",
          "Latest measured value at each ground station for one pollutant, sorted, with provider, grade (reference monitor or low-cost), "
          "district and measurement time.",
          {"city": CITY_PROP, "pollutant": {"type": "string", "enum": POLLUTANT_ENUM},
           "order": {"type": "string", "enum": ["highest", "lowest"], "description": "Default highest"},
           "limit": {"type": "integer", "minimum": 1, "maximum": 50, "description": "Default 15"}},
          ["city", "pollutant"]),
    _tool("get_air_by_district",
          "Latest measured pollutant values aggregated per district (median, max, station count), using a PostGIS spatial join of stations to districts. "
          "Districts without a reporting station are listed separately.",
          {"city": CITY_PROP, "pollutant": {"type": "string", "enum": POLLUTANT_ENUM}}, ["city", "pollutant"]),
    _tool("get_air_history",
          "Hourly network medians of measured PM2.5, PM10 and NO2 for a city (reference monitors when the city has any, else low-cost sensors).",
          {"city": CITY_PROP, "hours": {"type": "integer", "minimum": 2, "maximum": 168, "description": "Default 48"}}, ["city"]),
    _tool("get_station_history", "Hourly mean readings of one station (id from get_air_stations) for one pollutant.",
          {"station_id": {"type": "string", "maxLength": 120}, "pollutant": {"type": "string", "enum": POLLUTANT_ENUM},
           "hours": {"type": "integer", "minimum": 2, "maximum": 168, "description": "Default 48"}},
          ["station_id", "pollutant"]),
    _tool("get_anomalies",
          "Anomalies CityTwin's detector found in the latest measured readings (robust temporal and spatial z-scores plus an IsolationForest), "
          "city-wide pollution episodes, coverage of the detector, and flags from the last 24 h.",
          {"city": CITY_PROP}, ["city"]),
    _tool("get_weather",
          "Current weather and the next 24 h from Open-Meteo, plus modelled air quality (CAMS) for the city centre. Model output, not measurements.",
          {"city": CITY_PROP}, ["city"]),
    _tool("get_traffic",
          "Live traffic where a public feed exists: Istanbul (İBB city traffic index), London (TfL corridor status and disruptions), "
          "New York (NYC DOT measured link speeds). Other cities have no live traffic feed.",
          {"city": CITY_PROP}, ["city"]),
]
TOOL_SCHEMAS = {t["name"]: t["input_schema"] for t in TOOLS}

_TYPES = {"string": str, "integer": int, "number": (int, float), "boolean": bool, "object": dict}


def validate(name: str, args: Any) -> str | None:
    """Check a tool input against its schema. With eager input streaming the API does not
    validate inputs, so this runs before every call. Returns an error message or None."""
    schema = TOOL_SCHEMAS.get(name)
    if schema is None:
        return f"Unknown tool '{name}'"
    if not isinstance(args, dict):
        return "Input must be a JSON object"
    props = schema["properties"]
    for key in schema["required"]:
        if key not in args:
            return f"Missing required field '{key}'"
    for key, value in args.items():
        spec = props.get(key)
        if spec is None:
            return f"Unexpected field '{key}'"
        expected = _TYPES[spec["type"]]
        if isinstance(value, bool) and spec["type"] in ("integer", "number") or not isinstance(value, expected):
            return f"Field '{key}' must be of type {spec['type']}"
        if "enum" in spec and value not in spec["enum"]:
            return f"Field '{key}' must be one of {spec['enum']}"
        if "minimum" in spec and value < spec["minimum"] or "maximum" in spec and value > spec["maximum"]:
            return f"Field '{key}' out of range [{spec.get('minimum')}, {spec.get('maximum')}]"
        if "maxLength" in spec and len(value) > spec["maxLength"]:
            return f"Field '{key}' too long"
    return None


def _iso(dt: datetime | None) -> str | None:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if dt else None


class ToolContext:
    """What the tools need from the running app."""

    def __init__(self, pool, sensors, http):
        self.pool = pool
        self.sensors = sensors
        self.http = http

    # -------------------------------------------------------------- geo

    async def get_city_overview(self, city: str) -> dict:
        c = CITIES[city]
        geo = await self.pool.fetchrow(
            "SELECT count(*) AS n, round(coalesce(sum(ST_Area(geom::geography)), 0)::numeric / 1e6, 1)::float8 AS km2 FROM district WHERE city_id = $1",
            city,
        )
        feed = await self.sensors.snapshot(city)
        stations = feed["stations"]
        has_ref = any(s["grade"] == "reference" for s in stations)
        pick = [s for s in stations if s["grade"] == ("reference" if has_ref else "low-cost")]
        medians = {}
        for p in POLLUTANT_ENUM:
            vals = [s["values"][p] for s in pick if p in s["values"]]
            if vals:
                medians[p] = {"median": round(median(vals), 1), "stations": len(vals), "unit": "µg/m³"}
        times = sorted(s["measuredAt"] for s in stations if s["measuredAt"])
        an = self.sensors.anomalies.get(city)
        return {
            "city": {"id": c.id, "name": c.name, "country": c.country, "timezone": c.timezone},
            "districts": {"count": geo["n"], "totalAreaKm2": geo["km2"], "source": "OpenStreetMap administrative boundaries"},
            "groundStations": {
                "networkMedians": medians,
                "basis": "reference monitors" if has_ref else "low-cost sensors (indicative)",
                "byProvider": {p: sum(1 for s in stations if s["provider"] == p) for p in sorted({s["provider"] for s in stations})},
                "measuredBetween": [times[0], times[-1]] if times else None,
                "providers": [{k: s[k] for k in ("id", "label", "state", "detail")} for s in feed["sources"]],
                "polledAt": feed.get("polledAt"),
            },
            "anomalies": {"current": len(an["anomalies"]), "episodes": len(an["episodes"]), "generatedAt": an["generatedAt"]} if an else "not computed yet",
            "simulatedInDashboard": ["energy consumption and baselines", "building energy use", "noise", "zone demographics without an OSM population tag",
                                     "per-road traffic colours" + ("" if city in ("london", "newyork") else " (no live per-road feed for this city)")],
            "provenance": {"source": "sensor", "provider": "CityTwin backend (PostGIS + sensor poller)"},
        }

    async def list_districts(self, city: str) -> dict:
        rows = await self.pool.fetch(
            """SELECT name, name_en, population, population_date,
                      round((ST_Area(geom::geography) / 1e6)::numeric, 2)::float8 AS km2
               FROM district WHERE city_id = $1 ORDER BY name""",
            city,
        )
        return {
            "city": city,
            "districts": [{"name": r["name"], "nameEn": r["name_en"], "areaKm2": r["km2"], "population": r["population"],
                           "populationDate": r["population_date"]} for r in rows],
            "notes": "population is the OSM population tag (often a census figure); null means OSM has no tag.",
            "provenance": {"source": "external-api", "provider": "OpenStreetMap via CityTwin import pipeline"},
        }

    async def find_district(self, city: str, lon: float, lat: float) -> dict:
        r = await self.pool.fetchrow(
            "SELECT name FROM district WHERE city_id = $1 AND ST_Intersects(geom, ST_SetSRID(ST_MakePoint($2, $3), 4326)) LIMIT 1",
            city, lon, lat,
        )
        return {"city": city, "lon": lon, "lat": lat, "district": r["name"] if r else None,
                "provenance": {"source": "external-api", "provider": "OpenStreetMap boundaries in PostGIS"}}

    # -------------------------------------------------------------- air

    async def _station_districts(self, city: str) -> dict[str, str | None]:
        rows = await self.pool.fetch(
            """SELECT s.id, d.name FROM sensor s LEFT JOIN LATERAL (
                 SELECT name FROM district d WHERE d.city_id = s.city_id AND ST_Intersects(d.geom, s.geom) LIMIT 1) d ON true
               WHERE s.city_id = $1""",
            city,
        )
        return {r["id"]: r["name"] for r in rows}

    async def get_air_stations(self, city: str, pollutant: str, order: str = "highest", limit: int = 15) -> dict:
        feed = await self.sensors.snapshot(city)
        where = await self._station_districts(city)
        rows = [s for s in feed["stations"] if pollutant in s["values"]]
        rows.sort(key=lambda s: s["values"][pollutant], reverse=order == "highest")
        return {
            "city": city, "pollutant": pollutant, "unit": "µg/m³", "reporting": len(rows), "returned": min(limit, len(rows)),
            "stations": [{"id": s["id"], "name": s["name"], "district": where.get(s["id"]), "provider": s["provider"], "grade": s["grade"],
                          "value": s["values"][pollutant], "measuredAt": s["measuredAt"], "lon": s["lon"], "lat": s["lat"]} for s in rows[:limit]],
            "provenance": {"source": "sensor", "provider": ", ".join(sorted({s["provider"] for s in rows})) or "none"},
        }

    async def get_air_by_district(self, city: str, pollutant: str) -> dict:
        feed = await self.sensors.snapshot(city)
        where = await self._station_districts(city)
        groups: dict[str, list[dict]] = {}
        for s in feed["stations"]:
            if pollutant in s["values"] and where.get(s["id"]):
                groups.setdefault(where[s["id"]], []).append(s)
        names = [r["name"] for r in await self.pool.fetch("SELECT name FROM district WHERE city_id = $1 ORDER BY name", city)]
        out = []
        for name, ss in groups.items():
            vals = [s["values"][pollutant] for s in ss]
            out.append({"district": name, "median": round(median(vals), 1), "max": round(max(vals), 1), "stations": len(ss),
                        "grades": sorted({s["grade"] for s in ss})})
        out.sort(key=lambda d: d["median"], reverse=True)
        return {"city": city, "pollutant": pollutant, "unit": "µg/m³", "districts": out,
                "districtsWithoutStation": [n for n in names if n not in groups],
                "provenance": {"source": "sensor", "provider": "Ground stations joined to OSM districts in PostGIS",
                               "note": "A district median from one low-cost sensor is indicative only."}}

    async def get_air_history(self, city: str, hours: int = 48) -> dict:
        points = await self.sensors.history(city, hours)
        stats = {}
        for p in HISTORY_POLLUTANTS:
            vals = [(pt["time"], pt[p]) for pt in points if p in pt]
            if vals:
                hi = max(vals, key=lambda t: t[1])
                lo = min(vals, key=lambda t: t[1])
                stats[p] = {"mean": round(sum(v for _, v in vals) / len(vals), 1), "max": {"time": hi[0], "value": hi[1]},
                            "min": {"time": lo[0], "value": lo[1]}, "hours": len(vals)}
        return {"city": city, "hours": hours, "unit": "µg/m³", "summary": stats, "hourly": points[-72:],
                "notes": "hourly network medians; 'hourly' holds at most the last 72 points" if len(points) > 72 else "hourly network medians",
                "provenance": {"source": "sensor", "provider": "CityTwin sensor store (PostGIS)"}}

    async def get_station_history(self, station_id: str, pollutant: str, hours: int = 48) -> dict:
        meta = await self.pool.fetchrow("SELECT name, provider, grade, city_id FROM sensor WHERE id = $1", station_id)
        if not meta:
            return {"error": f"Unknown station '{station_id}'. Use get_air_stations to find ids."}
        rows = await self.pool.fetch(
            """SELECT date_trunc('hour', measured_at) AS h, avg(value) AS v FROM reading
               WHERE sensor_id = $1 AND pollutant = $2 AND measured_at > now() - make_interval(hours => $3)
               GROUP BY 1 ORDER BY 1""",
            station_id, pollutant, hours,
        )
        return {"station": {"id": station_id, **dict(meta)}, "pollutant": pollutant, "unit": "µg/m³",
                "hourly": [{"time": _iso(r["h"]), "value": round(r["v"], 1)} for r in rows],
                "provenance": {"source": "sensor", "provider": meta["provider"]}}

    async def get_anomalies(self, city: str) -> dict:
        result = self.sensors.anomalies.get(city) or await anomalies.run(self.pool, city)
        return {k: result[k] for k in ("generatedAt", "anomalies", "episodes", "coverage", "recent", "method", "provenance") if k in result} | {
            "anomalies": result["anomalies"][:30], "anomaliesTotal": len(result["anomalies"])}

    # -------------------------------------------------------------- weather / traffic

    _weather_cache: dict[str, tuple[float, dict]] = {}

    async def get_weather(self, city: str) -> dict:
        hit = self._weather_cache.get(city)
        if hit and hit[0] > time.monotonic():
            return hit[1]
        c = CITIES[city]
        common = {"latitude": c.lat, "longitude": c.lon, "timezone": "UTC"}
        w = (await get_with_retry(self.http, "https://api.open-meteo.com/v1/forecast", params={
            **common, "current": "temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m",
            "hourly": "temperature_2m,precipitation_probability,wind_speed_10m", "forecast_hours": 24})).json()
        a = (await get_with_retry(self.http, "https://air-quality-api.open-meteo.com/v1/air-quality", params={
            **common, "current": "european_aqi,pm2_5,pm10,nitrogen_dioxide,ozone"})).json()
        h = w.get("hourly", {})

        def series(key: str) -> list[float]:
            return [v for v in h.get(key) or [] if v is not None]

        temps, rain, wind = series("temperature_2m"), series("precipitation_probability"), series("wind_speed_10m")
        result = {
            "city": city,
            "weatherNow": w.get("current"), "weatherUnits": w.get("current_units"),
            "next24h": {"tempMin": min(temps, default=None), "tempMax": max(temps, default=None),
                        "maxPrecipitationProbability": max(rain, default=None), "maxWindKmh": max(wind, default=None)},
            "modelledAirNow": a.get("current"), "modelledAirUnits": a.get("current_units"),
            "provenance": {"source": "external-api", "provider": "Open-Meteo (weather models; air quality from CAMS)",
                           "note": "Model output at ~11-45 km resolution, not measurements. Times are UTC."},
        }
        self._weather_cache[city] = (time.monotonic() + 600, result)
        return result

    async def get_traffic(self, city: str) -> dict:
        if city == "istanbul":
            base = "https://api.ibb.gov.tr/tkmservices/api/TrafficData/v1"
            cur = json.loads((await lenient_get(f"{base}/TrafficIndex_Sc1_Cont")).content)
            hist = json.loads((await lenient_get(f"{base}/TrafficIndexHistory/1/15M")).content)
            tz = ZoneInfo("Europe/Istanbul")
            pts = [(datetime.fromisoformat(x["TrafficIndexDate"][:19]).replace(tzinfo=tz), x["TrafficIndex"]) for x in hist if x.get("TrafficIndex") is not None]
            pts.sort()
            peak = max(pts, key=lambda t: t[1]) if pts else None
            return {"city": city, "cityIndexPercent": cur.get("TI"), "europeanSide": cur.get("TI_Av"), "anatolianSide": cur.get("TI_An"),
                    "last24h": {"points": len(pts), "peak": {"time": _iso(peak[0]), "value": peak[1]} if peak else None,
                                "latest": {"time": _iso(pts[-1][0]), "value": pts[-1][1]} if pts else None},
                    "notes": "City-wide congestion index (%) from İBB; no per-road speeds are published.",
                    "provenance": {"source": "external-api", "provider": "İBB Trafik İndeksi"}}
        if city == "london":
            corridors = (await get_with_retry(self.http, "https://api.tfl.gov.uk/Road")).json()
            disruptions = (await get_with_retry(self.http, "https://api.tfl.gov.uk/Road/all/Disruption")).json()
            serious = [d for d in disruptions if d.get("severity") in ("Serious", "Severe")]
            return {"city": city,
                    "corridors": [{"name": c["displayName"], "status": c["statusSeverity"], "description": c["statusSeverityDescription"]} for c in corridors],
                    "disruptions": {"total": len(disruptions), "bySeverity": {s: sum(1 for d in disruptions if d.get("severity") == s) for s in sorted({d.get("severity") for d in disruptions if d.get("severity")})},
                                    "withClosures": sum(1 for d in disruptions if d.get("hasClosures")),
                                    "serious": [{"category": d.get("category"), "location": d.get("location"), "comments": (d.get("comments") or "")[:240],
                                                 "start": d.get("startDateTime"), "end": d.get("endDateTime")} for d in serious[:10]]},
                    "provenance": {"source": "external-api", "provider": "Transport for London Unified API"}}
        if city == "newyork":
            rows = (await get_with_retry(self.http, "https://data.cityofnewyork.us/resource/i4gi-tjb9.json", params={
                "$select": "link_id,link_name,borough,speed,data_as_of", "$order": "data_as_of DESC", "$limit": "1500"})).json()
            latest: dict[str, dict] = {}
            for r in rows:
                latest.setdefault(r["link_id"], r)
            links = [r for r in latest.values() if r.get("speed")]
            speeds = sorted(float(r["speed"]) for r in links)
            slow = sorted(links, key=lambda r: float(r["speed"]))[:8]
            boroughs: dict[str, list[float]] = {}
            for r in links:
                boroughs.setdefault(r.get("borough") or "?", []).append(float(r["speed"]))
            return {"city": city, "links": len(links), "medianSpeedMph": round(median(speeds), 1) if speeds else None,
                    "medianByBorough": {b: round(median(v), 1) for b, v in boroughs.items()},
                    "slowestLinks": [{"name": r.get("link_name"), "borough": r.get("borough"), "speedMph": float(r["speed"]), "asOfLocal": r.get("data_as_of")} for r in slow],
                    "notes": "Measured speeds from NYC DOT/TRANSCOM sensors on major links; data_as_of is New York local time.",
                    "provenance": {"source": "sensor", "provider": "NYC DOT real-time traffic speeds"}}
        return {"city": city, "available": False,
                "notes": "No public live traffic feed is connected for this city; the dashboard's traffic values here are simulated.",
                "provenance": {"source": "simulated", "provider": "none"}}


Handler = Callable[..., Awaitable[dict]]


async def execute(ctx: ToolContext, name: str, args: dict) -> tuple[bool, str]:
    """Run one tool. Returns (ok, JSON text for the tool_result)."""
    if err := validate(name, args):
        return False, json.dumps({"error": err})
    handler: Handler = getattr(ctx, name)
    try:
        result = await handler(**args)
    except Exception as e:  # upstream down, bad data … report it to the model instead of failing the turn
        log.warning("tool %s failed: %s", name, e)
        return False, json.dumps({"error": f"{type(e).__name__}: {str(e)[:300]}"})
    text = json.dumps(result, ensure_ascii=False, default=str)
    if len(text) > MAX_RESULT_CHARS:
        return False, json.dumps({"error": f"Result too large ({len(text)} chars). Ask for fewer rows (e.g. a smaller limit or shorter window)."})
    return "error" not in result, text
