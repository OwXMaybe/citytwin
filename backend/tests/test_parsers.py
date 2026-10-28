"""Pure unit tests for provider parsing (no DB, no network)."""

from datetime import datetime, timezone

import pytest

from app.services.sensors import ibb_window, parse_ibb_readings, parse_sensor_community, to_ugm3


def test_ibb_window_is_hour_aligned_local_time():
    start, end = ibb_window(3, now=datetime(2026, 10, 24, 20, 47, 13, tzinfo=timezone.utc))
    # 20:47 UTC = 23:47 Istanbul → window 20:00–23:00 local, whole hours only
    assert end == "24.10.2026 23:00:00"
    assert start == "24.10.2026 20:00:00"


def test_parse_ibb_takes_latest_non_null_and_converts_to_utc():
    rows = [
        {"ReadTime": "2026-10-24T21:00:00", "Concentration": {"PM10": 30.0, "NO2": None}},
        {"ReadTime": "2026-10-24T22:00:00", "Concentration": {"PM10": 35.5, "NO2": 40.1, "XYZ": 1}},
        {"ReadTime": "2026-10-24T23:00:00", "Concentration": None},
    ]
    values, measured_at, readings = parse_ibb_readings(rows)
    assert values == {"pm10": 35.5, "no2": 40.1}
    assert measured_at == datetime(2026, 10, 24, 19, 0, tzinfo=timezone.utc)
    assert len(readings) == 3


def test_parse_sensor_community_filters_faults_and_indoor():
    def entry(loc_id, p1, p2, indoor=0):
        return {
            "timestamp": "2026-10-24 20:11:37",
            "location": {"id": loc_id, "latitude": "52.5", "longitude": "13.4", "indoor": indoor},
            "sensor": {"id": loc_id * 10, "sensor_type": {"name": "SDS011"}},
            "sensordatavalues": [{"value_type": "P1", "value": p1}, {"value_type": "P2", "value": p2}],
        }

    stations = parse_sensor_community([entry(1, "12.0", "6.5"), entry(2, "999.9", "1.0"), entry(3, "5", "5", indoor=1)])
    by_id = {s.id: s for s in stations}
    assert by_id["sc-1"].values == {"pm10": 12.0, "pm25": 6.5}
    assert by_id["sc-2"].values == {"pm25": 1.0}  # 999.9 discarded as a fault
    assert "sc-3" not in by_id  # indoor
    assert by_id["sc-1"].grade == "low-cost"


@pytest.mark.parametrize(("param", "value", "units", "expected"), [
    ("no2", 10, "ppb", 18.82),
    ("o3", 0.03, "ppm", 58.9),
    ("pm25", 12, "µg/m³", 12),
])
def test_to_ugm3(param, value, units, expected):
    assert to_ugm3(param, value, units) == pytest.approx(expected, rel=0.01)
