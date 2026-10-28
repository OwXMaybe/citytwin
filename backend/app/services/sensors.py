"""Ground air-quality stations: poll providers, persist readings in PostGIS, push via WebSocket.

Server-side port of src/services/air/stations.ts. Feed JSON uses the same shape as the
frontend's StationFeed so the client can use either source interchangeably.
"""

import asyncio
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import asyncpg
import httpx

from ..cities import CITIES, City
from ..config import Settings
from ..upstream import SingleFlight, get_with_retry
from . import anomalies
from .ws_hub import Hub

log = logging.getLogger(__name__)

POLLUTANTS = ("pm25", "pm10", "no2", "o3", "so2", "co")
STALE = timedelta(hours=6)
IST = ZoneInfo("Europe/Istanbul")
IBB = "https://api.ibb.gov.tr/havakalitesi/OpenDataPortalHandler"
IBB_KEYS = {"PM25": "pm25", "PM10": "pm10", "NO2": "no2", "O3": "o3", "SO2": "so2", "CO": "co"}


@dataclass
class Station:
    id: str
    name: str
    lon: float
    lat: float
    provider: str
    grade: str
    values: dict[str, float] = field(default_factory=dict)
    measured_at: datetime | None = None
    readings: list[tuple[str, datetime, float]] = field(default_factory=list)  # full window, for persistence

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "lon": self.lon,
            "lat": self.lat,
            "provider": self.provider,
            "grade": self.grade,
            "values": self.values,
            "measuredAt": self.measured_at.isoformat() if self.measured_at else None,
        }


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


# ------------------------------------------------------------------ İBB (Istanbul)

def ibb_window(hours: int, now: datetime | None = None) -> tuple[str, str]:
    """İBB samples hourly *from* StartDate, so both ends sit on whole local hours."""
    end = (now or now_utc()).astimezone(IST).replace(minute=0, second=0, microsecond=0)
    start = end - timedelta(hours=hours)
    fmt = "%d.%m.%Y %H:%M:%S"
    return start.strftime(fmt), end.strftime(fmt)


def parse_ibb_readings(rows: list[dict]) -> tuple[dict[str, float], datetime | None, list[tuple[str, datetime, float]]]:
    values: dict[str, float] = {}
    measured_at: datetime | None = None
    readings: list[tuple[str, datetime, float]] = []
    for r in rows:
        conc = r.get("Concentration")
        if not conc:
            continue
        t = datetime.fromisoformat(r["ReadTime"]).replace(tzinfo=IST).astimezone(timezone.utc)
        for k, v in conc.items():
            key = IBB_KEYS.get(k)
            if key is None or v is None:
                continue
            values[key] = float(v)  # chronological → last non-null wins
            measured_at = t
            readings.append((key, t, float(v)))
    return values, measured_at, readings


async def fetch_ibb(client: httpx.AsyncClient, hours: int) -> list[Station]:
    resp = await get_with_retry(client, f"{IBB}/GetAQIStations")
    resp.raise_for_status()
    start, end = ibb_window(hours)
    sem = asyncio.Semaphore(8)

    async def one(s: dict) -> Station | None:
        m = re.match(r"POINT \(([-\d.]+) ([-\d.]+)\)", s.get("Location", ""))
        if not m:
            return None
        async with sem:
            r = await get_with_retry(client, f"{IBB}/GetAQIByStationId", params={"StationId": s["Id"], "StartDate": start, "EndDate": end})
        if r.status_code != 200:
            return None
        values, measured_at, readings = parse_ibb_readings(r.json())
        if not measured_at or now_utc() - measured_at > STALE:
            return None
        return Station(f"ibb-{s['Id']}", s["Name"], float(m.group(1)), float(m.group(2)), "ibb", "reference", values, measured_at, readings)

    results = await asyncio.gather(*(one(s) for s in resp.json()), return_exceptions=True)
    return [r for r in results if isinstance(r, Station)]


# ------------------------------------------------------------------ Sensor.Community

def parse_sensor_community(rows: list[dict]) -> list[Station]:
    by_loc: dict[int, Station] = {}
    for r in rows:
        loc = r["location"]
        if loc.get("indoor"):
            continue
        vals = {v["value_type"]: v["value"] for v in r["sensordatavalues"]}
        out: dict[str, float] = {}
        for src, key in (("P1", "pm10"), ("P2", "pm25")):
            try:
                v = float(vals[src])
            except (KeyError, ValueError):
                continue
            if 0 <= v < 500:  # discard sensor faults / fog saturation
                out[key] = v
        if not out:
            continue
        t = datetime.fromisoformat(r["timestamp"].replace(" ", "T")).replace(tzinfo=timezone.utc)
        by_loc[loc["id"]] = Station(
            f"sc-{loc['id']}",
            f"{r['sensor']['sensor_type']['name']} #{r['sensor']['id']}",
            float(loc["longitude"]),
            float(loc["latitude"]),
            "sensor.community",
            "low-cost",
            out,
            t,
            [(k, t, v) for k, v in out.items()],
        )
    return list(by_loc.values())[:400]


async def fetch_sensor_community(client: httpx.AsyncClient, city: City) -> list[Station]:
    resp = await get_with_retry(client, f"https://data.sensor.community/airrohr/v1/filter/area={city.lat},{city.lon},12")
    resp.raise_for_status()
    return parse_sensor_community(resp.json())


# ------------------------------------------------------------------ OpenAQ v3

MOLAR_MASS = {"no2": 46.01, "o3": 48.0, "so2": 64.07, "co": 28.01}


def to_ugm3(param: str, value: float, units: str) -> float:
    u = units.lower()
    if param not in MOLAR_MASS or "µg" in u or "ug" in u:
        return value
    ppb = value * 1000 if u == "ppm" else value
    return ppb * MOLAR_MASS[param] / 24.45


async def fetch_openaq(client: httpx.AsyncClient, city: City, key: str) -> list[Station]:
    headers = {"X-API-Key": key}
    resp = await get_with_retry(client, "https://api.openaq.org/v3/locations", params={"coordinates": f"{city.lat},{city.lon}", "radius": 25000, "limit": 60}, headers=headers)
    resp.raise_for_status()
    now = now_utc()
    fresh = [
        loc for loc in resp.json()["results"]
        if loc.get("datetimeLast") and now - datetime.fromisoformat(loc["datetimeLast"]["utc"].replace("Z", "+00:00")) < STALE
    ][:25]  # stay inside 60 requests/minute
    stations: list[Station] = []
    for loc in fresh:
        r = await get_with_retry(client, f"https://api.openaq.org/v3/locations/{loc['id']}/latest", headers=headers)
        if r.status_code != 200:
            continue
        sensors = {s["id"]: s["parameter"] for s in loc["sensors"]}
        values: dict[str, float] = {}
        measured_at: datetime | None = None
        for item in r.json()["results"]:
            p = sensors.get(item["sensorsId"])
            if not p or p["name"] not in POLLUTANTS or item["value"] is None or item["value"] < 0:
                continue
            t = datetime.fromisoformat(item["datetime"]["utc"].replace("Z", "+00:00"))
            if now - t > STALE:
                continue
            values[p["name"]] = round(to_ugm3(p["name"], float(item["value"]), p["units"]), 1)
            measured_at = max(measured_at, t) if measured_at else t
        if values and measured_at:
            stations.append(Station(
                f"oaq-{loc['id']}", loc["name"], loc["coordinates"]["longitude"], loc["coordinates"]["latitude"],
                "openaq", "reference" if loc.get("isMonitor") else "low-cost", values, measured_at,
                [(k, measured_at, v) for k, v in values.items()],
            ))
        await asyncio.sleep(0.5)
    return stations


# ------------------------------------------------------------------ service

class SensorService:
    def __init__(self, pool: asyncpg.Pool, client: httpx.AsyncClient, settings: Settings, hub: Hub):
        self.pool = pool
        self.client = client
        self.settings = settings
        self.hub = hub
        self.snapshots: dict[str, dict] = {}
        self.last_run: dict[str, str] = {}
        self.anomalies: dict[str, dict] = {}
        self._ibb_backfilled = False
        self._flight = SingleFlight()

    async def poll_city(self, city_id: str) -> dict:
        city = CITIES[city_id]
        async with self._flight.lock(f"poll:{city_id}"):
            sources: list[dict] = []
            stations: list[Station] = []

            async def run(pid: str, label: str, applies: bool, coro_factory, offline_detail: str = "No coverage configured for this city"):
                if not applies:
                    sources.append({"id": pid, "label": label, "state": "offline", "detail": offline_detail, "count": 0})
                    return
                try:
                    found = await coro_factory()
                    stations.extend(found)
                    sources.append({"id": pid, "label": label, "state": "ok" if found else "empty",
                                    "detail": f"{len(found)} stations reporting" if found else "No current readings in range", "count": len(found)})
                except Exception as e:  # provider down — keep the others
                    log.warning("%s poll failed for %s: %s", pid, city_id, e)
                    sources.append({"id": pid, "label": label, "state": "error", "detail": f"{type(e).__name__}: {e}"[:160], "count": 0})

            hours = 3 if self._ibb_backfilled else 48
            key = self.settings.openaq_api_key
            await asyncio.gather(
                run("ibb", "İBB Hava Kalitesi", city_id == "istanbul", lambda: fetch_ibb(self.client, hours)),
                run("sensor.community", "Sensor.Community", True, lambda: fetch_sensor_community(self.client, city)),
                run("openaq", "OpenAQ", bool(key), lambda: fetch_openaq(self.client, city, key or ""),
                    offline_detail="Set OPENAQ_API_KEY in .env.local and restart the backend"),
            )
            if city_id == "istanbul":
                self._ibb_backfilled = True
            await self._persist(city_id, stations)
            feed = {
                "stations": [s.to_json() for s in stations],
                "history": await self.history(city_id),
                "sources": sources,
                "servedBy": "backend",
                "polledAt": now_utc().isoformat(),
            }
            self.snapshots[city_id] = feed
            self.last_run[city_id] = feed["polledAt"]
        await self.hub.broadcast(city_id, {"type": "update", "city": city_id, "feed": feed})
        try:
            await self.detect(city_id)
        except Exception:
            log.exception("anomaly detection failed for %s", city_id)
        return feed

    async def detect(self, city_id: str) -> dict:
        """Score the latest readings (Phase 5) and push the result to that city's sockets."""
        result = await anomalies.run(self.pool, city_id)
        self.anomalies[city_id] = result
        await self.hub.broadcast(city_id, {"type": "anomalies", "city": city_id, "result": result})
        return result

    async def snapshot(self, city_id: str) -> dict:
        return self.snapshots.get(city_id) or await self.poll_city(city_id)

    async def _persist(self, city_id: str, stations: list[Station]) -> None:
        if not stations:
            return
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.executemany(
                """INSERT INTO sensor (id, city_id, provider, grade, name, geom, last_seen)
                   VALUES ($1, $2, $3, $4, $5, ST_SetSRID(ST_MakePoint($6, $7), 4326), now())
                   ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, grade = EXCLUDED.grade,
                     geom = EXCLUDED.geom, last_seen = now()""",
                [(s.id, city_id, s.provider, s.grade, s.name, s.lon, s.lat) for s in stations],
            )
            await conn.executemany(
                "INSERT INTO reading (sensor_id, pollutant, measured_at, value) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
                [(s.id, p, t, v) for s in stations for (p, t, v) in s.readings],
            )

    async def history(self, city_id: str, hours: int = 48) -> list[dict]:
        """Hourly network medians from stored readings (reference monitors preferred)."""
        rows = await self.pool.fetch(
            """WITH r AS (
                 SELECT date_trunc('hour', rd.measured_at) AS h, rd.pollutant, rd.value, s.grade
                 FROM reading rd JOIN sensor s ON s.id = rd.sensor_id
                 WHERE s.city_id = $1 AND rd.measured_at > now() - make_interval(hours => $2)
                   AND rd.pollutant IN ('pm10', 'pm25', 'no2')),
               pick AS (SELECT CASE WHEN bool_or(grade = 'reference') THEN 'reference' ELSE 'low-cost' END AS g FROM r)
               SELECT h, pollutant, percentile_cont(0.5) WITHIN GROUP (ORDER BY value) AS med
               FROM r, pick WHERE r.grade = pick.g GROUP BY h, pollutant ORDER BY h""",
            city_id,
            hours,
        )
        by_hour: dict[datetime, dict] = {}
        for r in rows:
            point = by_hour.setdefault(r["h"], {"time": r["h"].isoformat().replace("+00:00", "Z")})
            point[r["pollutant"]] = round(r["med"], 1)
        points = list(by_hour.values())
        return points if len(points) >= 2 else []

    async def prune(self, days: int = 14) -> None:
        await self.pool.execute("DELETE FROM reading WHERE measured_at < now() - make_interval(days => $1)", days)

    async def run_forever(self) -> None:
        """Background poller: every city each cycle so history accumulates even without viewers."""
        while True:
            for city_id in CITIES:
                try:
                    await self.poll_city(city_id)
                except Exception:
                    log.exception("sensor poll failed for %s", city_id)
            try:
                await self.prune()
            except Exception:
                log.exception("prune failed")
            await asyncio.sleep(self.settings.sensor_poll_seconds)
