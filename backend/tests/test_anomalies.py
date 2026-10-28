"""Anomaly detector on synthetic series (pure function, no database)."""

import math
import random
from datetime import datetime, timedelta, timezone

from app.services.anomalies import SensorMeta, detect

NOW = datetime(2026, 10, 25, 12, 30, tzinfo=timezone.utc)
HOUR = NOW.replace(minute=0)


def network(n=20, hours=30, level=20.0, seed=1):
    """n stations on a ~3 km ring with steady PM10 around `level` plus noise."""
    rnd = random.Random(seed)
    meta, series = {}, {}
    for i in range(n):
        a = 2 * math.pi * i / n
        sid = f"s{i}"
        meta[sid] = SensorMeta(sid, f"Station {i}", "test", "reference", 29.0 + 0.03 * math.cos(a), 41.0 + 0.03 * math.sin(a))
        series[(sid, "pm10")] = [(HOUR - timedelta(hours=hours - 1 - h), level + rnd.gauss(0, 2)) for h in range(hours)]
    return meta, series


def kinds(result, sid):
    return {a["kind"] for a in result["anomalies"] if a["sensorId"] == sid}


def test_quiet_network_has_no_anomalies():
    meta, series = network()
    r = detect(series, meta, NOW)
    assert r["anomalies"] == []
    assert r["coverage"]["pm10"] == {"stations": 20, "withHistory": 20, "withNeighbours": 20, "isolationForest": True}


def test_spike_is_flagged_against_own_history():
    meta, series = network()
    pts = series[("s3", "pm10")]
    pts[-1] = (pts[-1][0], 140.0)
    r = detect(series, meta, NOW)
    assert kinds(r, "s3") == {"spike"}
    a = next(a for a in r["anomalies"] if a["sensorId"] == "s3")
    assert a["zTemporal"] > 10 and 15 < a["expected"] < 25
    assert a["severity"] == "warning"  # 140 µg/m³ PM10 is below the critical level (225)
    assert len(r["anomalies"]) == 1


def test_persistent_hotspot_is_spatial_not_temporal():
    meta, series = network()
    series[("s7", "pm10")] = [(h, v + 60) for h, v in series[("s7", "pm10")]]  # always high, so its own history looks normal
    r = detect(series, meta, NOW)
    assert kinds(r, "s7") == {"local-hotspot"}


def test_low_cost_sensor_is_never_critical():
    meta, series = network()
    meta["s5"].grade = "low-cost"
    pts = series[("s5", "pm10")]
    pts[-1] = (pts[-1][0], 400.0)
    r = detect(series, meta, NOW)
    assert next(a for a in r["anomalies"] if a["sensorId"] == "s5")["severity"] == "warning"


def test_small_network_skips_isolation_forest_and_short_history_skips_temporal():
    meta, series = network(n=6, hours=6)
    r = detect(series, meta, NOW)
    assert r["coverage"]["pm10"]["isolationForest"] is False
    assert r["coverage"]["pm10"]["withHistory"] == 0


def test_sensor_faults():
    meta, series = network()
    series[("s1", "pm10")] = [(h, 12.0) for h, _ in series[("s1", "pm10")]]  # stuck
    series[("s2", "pm25")] = [(h, 40.0) for h, _ in series[("s2", "pm10")]]  # PM2.5 above PM10 (~20)
    r = detect(series, meta, NOW)
    assert "sensor-fault" in kinds(r, "s1")
    assert "sensor-fault" in kinds(r, "s2")


def test_stale_stations_are_ignored():
    meta, series = network()
    later = NOW + timedelta(hours=5)
    assert detect(series, meta, later)["coverage"]["pm10"]["stations"] == 0
