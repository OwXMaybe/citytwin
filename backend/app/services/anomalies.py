"""Anomaly detection on measured ground-station readings (Phase 5).

Every value examined here is a real measurement from the sensor poller; only the
*judgement* that it is anomalous is CityTwin's, so results carry `source: estimated`.

Per pollutant and city, the latest hourly mean of each station is scored three ways:

  temporal  robust z against the station's own previous 48 h (median / MAD)
  spatial   robust z against its nearest neighbours right now (same pollutant)
  joint     IsolationForest over [log value, temporal z, spatial z] across all
            stations of the city (only with >= IF_MIN_STATIONS stations)

A value is flagged when a robust z clears its threshold, the absolute excess is large
enough to matter, and (when it could run) the IsolationForest agrees it is an outlier.
Separate rules catch sensor faults (PM2.5 > PM10, flat-lined or implausible values).
Dips are not flagged: falling pollution is rarely actionable and often just rain or wind.
"""

import asyncio
import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from statistics import median

import asyncpg
import numpy as np
from sklearn.ensemble import IsolationForest

PROVENANCE = {
    "source": "estimated",
    "provider": "CityTwin anomaly detector",
    "note": "Measured station readings scored with robust z-scores (temporal and spatial) and an IsolationForest. The readings are real; the anomaly judgement is a statistical estimate.",
}

POLLUTANTS = ("pm25", "pm10", "no2")
WINDOW_H = 48  # temporal baseline
FRESH_H = 2  # a station's latest hour must be this recent to be scored
MIN_HISTORY = 12  # hourly points needed for a temporal baseline
NEIGHBOURS = 6
NEIGHBOUR_KM = 15.0
MIN_NEIGHBOURS = 4
IF_MIN_STATIONS = 15
Z_FLAG = 4.0
# Robust-z denominators never go below these (µg/m³): a sensor reading 3.0, 3.1, 3.0 … would
# otherwise turn a move to 6 into a "z = 40" event.
SCALE_FLOOR = {"pm25": 2.0, "pm10": 4.0, "no2": 5.0}
# Minimum absolute excess over the expected value before anything is flagged (µg/m³).
MIN_EXCESS = {"pm25": 10.0, "pm10": 20.0, "no2": 20.0}
# Values at or above these are critical regardless of z (≈ 5× the WHO 2021 24 h guideline).
CRITICAL_LEVEL = {"pm25": 75.0, "pm10": 225.0, "no2": 125.0}
WHO_24H = {"pm25": 15.0, "pm10": 45.0, "no2": 25.0}
IMPLAUSIBLE = 1000.0
FLATLINE_H = 8


@dataclass
class SensorMeta:
    id: str
    name: str
    provider: str
    grade: str
    lon: float
    lat: float
    district: str | None = None


Series = dict[tuple[str, str], list[tuple[datetime, float]]]  # (sensor, pollutant) -> hourly means, ascending


def robust(xs: list[float]) -> tuple[float, float]:
    """Median and MAD scaled to a normal σ."""
    m = median(xs)
    return m, 1.4826 * median(abs(x - m) for x in xs)


def haversine_km(a: SensorMeta, b: SensorMeta) -> float:
    p1, p2 = math.radians(a.lat), math.radians(b.lat)
    dp, dl = p2 - p1, math.radians(b.lon - a.lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 12742 * math.asin(math.sqrt(h))


def severity(pollutant: str, value: float, z: float, grade: str = "reference") -> str:
    """Critical needs a health-relevant concentration, not just a large z; a single
    low-cost sensor is never critical on its own (they drift and saturate in humidity)."""
    if value >= CRITICAL_LEVEL[pollutant] and grade == "reference":
        return "critical"
    if value >= CRITICAL_LEVEL[pollutant] or z >= 5 or value >= 2 * WHO_24H[pollutant]:
        return "warning"
    return "info"


def _r(x: float | None, nd: int = 1) -> float | None:
    return None if x is None or not math.isfinite(x) else round(x, nd)


def detect(series: Series, meta: dict[str, SensorMeta], now: datetime) -> dict:
    """Pure scoring step (no I/O) so it can be tested on synthetic data."""
    anomalies: list[dict] = []
    coverage: dict[str, dict] = {}
    episodes: list[dict] = []

    for pol in POLLUTANTS:
        current: list[dict] = []
        for (sid, p), pts in series.items():
            if p != pol or sid not in meta or not pts:
                continue
            hour, x = pts[-1]
            if hour < now - timedelta(hours=FRESH_H):
                continue
            base = [v for (h, v) in pts[:-1] if h >= hour - timedelta(hours=WINDOW_H)]
            c = {"sid": sid, "hour": hour, "x": x, "zt": None, "expected_t": None, "zs": None, "expected_s": None, "history": len(base)}
            if len(base) >= MIN_HISTORY:
                m, s = robust(base)
                c["zt"], c["expected_t"] = (x - m) / max(s, SCALE_FLOOR[pol]), m
            current.append(c)

        # Spatial: nearest neighbours reporting the same pollutant this hour.
        for c in current:
            me = meta[c["sid"]]
            near = sorted(
                ((haversine_km(me, meta[o["sid"]]), o["x"]) for o in current if o is not c),
                key=lambda t: t[0],
            )
            vals = [v for (d, v) in near[:NEIGHBOURS] if d <= NEIGHBOUR_KM]
            if len(vals) >= MIN_NEIGHBOURS:
                m, s = robust(vals)
                c["zs"], c["expected_s"] = (c["x"] - m) / max(s, SCALE_FLOOR[pol]), m

        # Joint model.
        use_if = len(current) >= IF_MIN_STATIONS
        if use_if:
            X = np.array([[math.log1p(max(c["x"], 0.0)), c["zt"] or 0.0, c["zs"] or 0.0] for c in current])
            forest = IsolationForest(n_estimators=200, contamination="auto", random_state=0).fit(X)
            scores = -forest.score_samples(X)  # higher = more isolated
            outlier = forest.predict(X) == -1
            for c, sc, out in zip(current, scores, outlier):
                c["if"], c["if_out"] = float(sc), bool(out)
        coverage[pol] = {
            "stations": len(current),
            "withHistory": sum(c["zt"] is not None for c in current),
            "withNeighbours": sum(c["zs"] is not None for c in current),
            "isolationForest": use_if,
        }

        for c in current:
            m = meta[c["sid"]]
            base = {
                "sensorId": c["sid"], "sensorName": m.name, "provider": m.provider, "grade": m.grade,
                "district": m.district, "lon": m.lon, "lat": m.lat, "pollutant": pol, "unit": "µg/m³",
                "value": _r(c["x"]), "hour": c["hour"].isoformat(), "zTemporal": _r(c["zt"], 2),
                "zSpatial": _r(c["zs"], 2), "ifScore": _r(c.get("if"), 3),
            }
            agrees = c.get("if_out", True) if use_if else True
            zt, zs = c["zt"] or 0.0, c["zs"] or 0.0
            if zt >= Z_FLAG and c["x"] - c["expected_t"] >= MIN_EXCESS[pol] and agrees:
                anomalies.append({**base, "kind": "spike", "expected": _r(c["expected_t"]), "severity": severity(pol, c["x"], zt, m.grade),
                                  "explanation": f"{pol.upper()} {c['x']:.0f} µg/m³ vs this station's 48 h median {c['expected_t']:.0f} (robust z {zt:.1f})."})
            elif zs >= Z_FLAG and c["x"] - c["expected_s"] >= MIN_EXCESS[pol] and agrees:
                anomalies.append({**base, "kind": "local-hotspot", "expected": _r(c["expected_s"]), "severity": severity(pol, c["x"], zs, m.grade),
                                  "explanation": f"{pol.upper()} {c['x']:.0f} µg/m³ vs {c['expected_s']:.0f} at the nearest stations (robust z {zs:.1f}). Could be a local source or a sensor issue."})
            elif c["x"] >= IMPLAUSIBLE or c["x"] < 0:
                anomalies.append({**base, "kind": "sensor-fault", "expected": None, "severity": "info",
                                  "explanation": f"Physically implausible {pol.upper()} reading ({c['x']:.0f} µg/m³)."})

        # City-wide episode: network median now vs the network's own recent hours.
        if len(current) >= 3:
            now_med = median(c["x"] for c in current)
            by_hour: dict[datetime, list[float]] = {}
            for (sid, p), pts in series.items():
                if p == pol and sid in meta:
                    for h, v in pts:
                        by_hour.setdefault(h, []).append(v)
            latest = max(c["hour"] for c in current)
            hist = [median(vs) for h, vs in by_hour.items() if latest - timedelta(hours=WINDOW_H) <= h < latest and len(vs) >= 3]
            if len(hist) >= MIN_HISTORY:
                m, s = robust(hist)
                z = (now_med - m) / max(s, SCALE_FLOOR[pol])
                if z >= 3 and now_med > WHO_24H[pol]:
                    episodes.append({"pollutant": pol, "value": _r(now_med), "expected": _r(m), "z": _r(z, 2), "stations": len(current),
                                     "severity": severity(pol, now_med, z),
                                     "explanation": f"City-wide {pol.upper()} median {now_med:.0f} µg/m³ vs {m:.0f} over the previous 48 h, above the WHO 24 h guideline ({WHO_24H[pol]:.0f})."})

    # Sensor faults independent of the statistics.
    for sid, m in meta.items():
        pm25, pm10 = series.get((sid, "pm25")), series.get((sid, "pm10"))
        if pm25 and pm10 and pm25[-1][0] == pm10[-1][0] and pm25[-1][0] >= now - timedelta(hours=FRESH_H):
            a, b = pm25[-1][1], pm10[-1][1]
            if a > b * 1.1 + 2:
                anomalies.append({"sensorId": sid, "sensorName": m.name, "provider": m.provider, "grade": m.grade, "district": m.district,
                                  "lon": m.lon, "lat": m.lat, "pollutant": "pm25", "unit": "µg/m³", "value": _r(a), "hour": pm25[-1][0].isoformat(),
                                  "zTemporal": None, "zSpatial": None, "ifScore": None, "kind": "sensor-fault", "expected": _r(b), "severity": "info",
                                  "explanation": f"PM2.5 ({a:.0f}) exceeds PM10 ({b:.0f}); PM2.5 is a subset of PM10, so one channel is faulty (often humidity on low-cost sensors)."})
        for pol in POLLUTANTS:
            pts = series.get((sid, pol)) or []
            tail = pts[-FLATLINE_H:]
            if len(tail) == FLATLINE_H and tail[-1][0] >= now - timedelta(hours=FRESH_H) and tail[-1][1] > 0 \
                    and len({round(v, 3) for _, v in tail}) == 1 and tail[-1][0] - tail[0][0] == timedelta(hours=FLATLINE_H - 1):
                anomalies.append({"sensorId": sid, "sensorName": m.name, "provider": m.provider, "grade": m.grade, "district": m.district,
                                  "lon": m.lon, "lat": m.lat, "pollutant": pol, "unit": "µg/m³", "value": _r(tail[-1][1]), "hour": tail[-1][0].isoformat(),
                                  "zTemporal": None, "zSpatial": None, "ifScore": None, "kind": "sensor-fault", "expected": None, "severity": "info",
                                  "explanation": f"{pol.upper()} has reported exactly {tail[-1][1]:g} µg/m³ for {FLATLINE_H} consecutive hours (stuck sensor?)."})

    rank = {"critical": 0, "warning": 1, "info": 2}
    anomalies.sort(key=lambda a: (rank[a["severity"]], -(max(a["zTemporal"] or 0, a["zSpatial"] or 0))))
    return {
        "generatedAt": now.isoformat(),
        "anomalies": anomalies,
        "episodes": episodes,
        "coverage": coverage,
        "method": {
            "features": ["log1p(value)", "temporal robust z (48 h, own station)", "spatial robust z (k=6 nearest within 15 km)"],
            "model": "IsolationForest(n_estimators=200, contamination='auto', random_state=0)",
            "thresholds": {"robustZ": Z_FLAG, "minExcess": MIN_EXCESS, "scaleFloor": SCALE_FLOOR, "minHistoryHours": MIN_HISTORY, "isolationForestMinStations": IF_MIN_STATIONS},
            "limitations": "No diurnal or weekly seasonality model yet (the 48 h MAD absorbs the daily cycle, which makes thresholds conservative). Dips are not flagged.",
        },
        "provenance": PROVENANCE,
    }


async def load_inputs(pool: asyncpg.Pool, city_id: str) -> tuple[Series, dict[str, SensorMeta]]:
    rows = await pool.fetch(
        """SELECT r.sensor_id, r.pollutant, date_trunc('hour', r.measured_at) AS h, avg(r.value) AS v
           FROM reading r JOIN sensor s ON s.id = r.sensor_id
           WHERE s.city_id = $1 AND r.pollutant = ANY($2::text[])
             AND r.measured_at > now() - make_interval(hours => $3)
           GROUP BY 1, 2, 3 ORDER BY 1, 2, 3""",
        city_id, list(POLLUTANTS), WINDOW_H + FRESH_H + 1,
    )
    series: Series = {}
    for r in rows:
        series.setdefault((r["sensor_id"], r["pollutant"]), []).append((r["h"], float(r["v"])))
    meta_rows = await pool.fetch(
        """SELECT s.id, s.name, s.provider, s.grade, ST_X(s.geom) AS lon, ST_Y(s.geom) AS lat, d.name AS district
           FROM sensor s LEFT JOIN LATERAL (
             SELECT name FROM district d WHERE d.city_id = s.city_id AND ST_Intersects(d.geom, s.geom) LIMIT 1) d ON true
           WHERE s.city_id = $1""",
        city_id,
    )
    meta = {r["id"]: SensorMeta(r["id"], r["name"], r["provider"], r["grade"], r["lon"], r["lat"], r["district"]) for r in meta_rows}
    return series, meta


async def run(pool: asyncpg.Pool, city_id: str) -> dict:
    series, meta = await load_inputs(pool, city_id)
    result = await asyncio.to_thread(detect, series, meta, datetime.now(timezone.utc))
    result["city"] = city_id
    flagged = result["anomalies"]
    if flagged:
        await pool.executemany(
            """INSERT INTO anomaly (sensor_id, pollutant, hour, city_id, kind, severity, value, expected, z_temporal, z_spatial, if_score, detail)
               VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8, $9, $10, $11, $12)
               ON CONFLICT (sensor_id, pollutant, hour) DO UPDATE SET kind = EXCLUDED.kind, severity = EXCLUDED.severity,
                 value = EXCLUDED.value, expected = EXCLUDED.expected, z_temporal = EXCLUDED.z_temporal,
                 z_spatial = EXCLUDED.z_spatial, if_score = EXCLUDED.if_score, detail = EXCLUDED.detail, detected_at = now()""",
            [(a["sensorId"], a["pollutant"], datetime.fromisoformat(a["hour"]), city_id, a["kind"], a["severity"], a["value"], a["expected"],
              a["zTemporal"], a["zSpatial"], a["ifScore"], {"explanation": a["explanation"], "sensorName": a["sensorName"]}) for a in flagged],
        )
    result["recent"] = await recent(pool, city_id, 24)
    return result


async def recent(pool: asyncpg.Pool, city_id: str, hours: int) -> list[dict]:
    rows = await pool.fetch(
        """SELECT a.sensor_id, a.pollutant, a.hour, a.kind, a.severity, a.value, a.expected, a.detail
           FROM anomaly a WHERE a.city_id = $1 AND a.hour > now() - make_interval(hours => $2)
           ORDER BY a.hour DESC LIMIT 200""",
        city_id, hours,
    )
    return [{"sensorId": r["sensor_id"], "sensorName": r["detail"].get("sensorName"), "pollutant": r["pollutant"],
             "hour": r["hour"].isoformat(), "kind": r["kind"], "severity": r["severity"], "value": r["value"],
             "expected": r["expected"], "explanation": r["detail"].get("explanation")} for r in rows]
