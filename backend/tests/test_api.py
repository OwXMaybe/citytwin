"""API tests against the local PostGIS database (no outbound network)."""

import httpx
import pytest

from app.routers import proxy as proxy_module
from tests.conftest import requires_db

pytestmark = requires_db


def test_health(client):
    r = client.get("/api/v1/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["postgis"].startswith("3.")
    assert body["districts"] == 211  # 39 + 25 + 30 + 12 + 32 + 5 + 11 + 9 + 17 + 12 + 19 from the OSM pipeline


def test_city_list_areas(client):
    cities = {c["id"]: c for c in client.get("/api/v1/cities").json()}
    assert set(cities) == {"istanbul", "ankara", "izmir", "tekirdag", "edirne", "bursa", "kocaeli", "antalya", "berlin", "london", "newyork"}
    # Official areas: Berlin 891.1 km², Greater London 1,572 km² (+ City of London excluded), NYC 1,214 km² incl. water
    assert cities["berlin"]["area_km2"] == pytest.approx(891, rel=0.02)
    assert cities["london"]["area_km2"] == pytest.approx(1572, rel=0.02)
    assert cities["newyork"]["area_km2"] == pytest.approx(1214, rel=0.02)


def test_districts_geojson_shape(client):
    fc = client.get("/api/v1/cities/berlin/districts").json()
    assert fc["metadata"]["servedBy"] == "PostGIS"
    assert len(fc["features"]) == 12
    f = next(x for x in fc["features"] if x["properties"]["name"] == "Mitte")
    assert f["geometry"]["type"] == "MultiPolygon"
    assert f["properties"]["areaKm2"] == pytest.approx(39.5, rel=0.05)
    lon, lat = f["properties"]["center"]
    assert 13.3 < lon < 13.45 and 52.5 < lat < 52.56


@pytest.mark.parametrize(
    ("city", "lon", "lat", "expected"),
    [
        ("berlin", 13.4132, 52.5219, "Mitte"),  # Alexanderplatz
        ("istanbul", 28.9869, 41.0370, "Beyoğlu"),  # Taksim
        ("london", -0.1276, 51.5034, "Westminster"),  # Downing Street
        ("newyork", -73.9855, 40.7580, "Manhattan"),  # Times Square
    ],
)
def test_district_at_point(client, city, lon, lat, expected):
    r = client.get(f"/api/v1/cities/{city}/districts/at", params={"lon": lon, "lat": lat})
    assert r.status_code == 200, r.text
    assert expected in r.json()["name"]


def test_district_at_point_outside(client):
    r = client.get("/api/v1/cities/berlin/districts/at", params={"lon": 0, "lat": 0})
    assert r.status_code == 404


def test_unknown_city(client):
    assert client.get("/api/v1/cities/atlantis/districts").status_code == 404


def test_proxy_guards(client):
    assert client.get("/api/v1/proxy/evil/x").status_code == 404
    assert client.get("/api/v1/proxy/ibb-air/..%2F..%2Fsecret").status_code in (400, 404)
    # No key configured in tests → explicit 503, never an anonymous upstream call
    assert client.get("/api/v1/proxy/openaq/v3/locations").status_code == 503


def test_proxy_caches_upstream(client, monkeypatch):
    calls = []

    async def fake_get(url, **kw):  # ibb-traffic goes through the lenient (urllib) client
        calls.append(url)
        return httpx.Response(200, json={"TI": 42}, headers={"content-type": "application/json"})

    monkeypatch.setattr(proxy_module, "lenient_get", fake_get)
    path = "/api/v1/proxy/ibb-traffic/TrafficIndex_Sc1_Cont?test=cache"
    r1 = client.get(path)
    r2 = client.get(path)
    assert r1.json() == {"TI": 42} and r2.json() == {"TI": 42}
    assert r1.headers["x-cache"] == "MISS" and r2.headers["x-cache"] == "HIT"
    assert len(calls) == 1


def test_overpass_rejects_non_json_queries(client):
    r = client.post("/api/v1/overpass", json={"query": "[out:xml];node(1);out;"})
    assert r.status_code == 400


def test_websocket_snapshot_and_update(client):
    app = client.app
    fake = {"stations": [{"id": "t-1", "name": "Test", "lon": 13.4, "lat": 52.5, "provider": "sensor.community", "grade": "low-cost", "values": {"pm25": 5.0}, "measuredAt": None}], "history": [], "sources": []}

    async def fake_snapshot(city_id):
        return fake

    original = app.state.sensors.snapshot
    app.state.sensors.snapshot = fake_snapshot
    try:
        with client.websocket_connect("/ws/sensors?city=berlin") as ws:
            first = ws.receive_json()
            assert first["type"] == "snapshot" and first["feed"]["stations"][0]["id"] == "t-1"
            client.portal.call(app.state.hub.broadcast, "berlin", {"type": "update", "city": "berlin", "feed": {**fake, "stations": []}})
            second = ws.receive_json()
            assert second["type"] == "update" and second["feed"]["stations"] == []
            ws.send_text("ping")
            assert ws.receive_json()["type"] == "pong"
    finally:
        app.state.sensors.snapshot = original


def test_websocket_unknown_city(client):
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/sensors?city=atlantis") as ws:
            ws.receive_json()


def test_frontend_cache_headers(client):
    if not client.app.state.settings.frontend_dist.is_dir():
        pytest.skip("frontend not built")
    index = client.get("/")
    assert index.status_code == 200 and index.headers["cache-control"] == "no-cache"
    import re

    asset = re.search(r'/(assets/[^"]+\.js)', index.text).group(1)
    r = client.get("/" + asset)
    assert r.status_code == 200 and "immutable" in r.headers["cache-control"]
