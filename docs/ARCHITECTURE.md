# CityTwin Architecture

## 1. Principles

1. **Provenance first.** Every datum is a `Metric`/`Provenance` with `source ∈ {sensor, external-api, simulated, estimated}`. Badges in the UI are generated from that field, never hard-coded. Simulated data is never shown without a label.
2. **Modules by data domain.** Geographic, environmental, traffic, energy, sensor, simulation and AI each live in their own service and, later, their own backend router.
3. **Swap the source, keep the shape.** Phase 1 services (`openMeteo.ts`, `simulated.ts`) return the same types the backend returns. The Phase 4 endpoints serve `DistrictCollection` and `StationFeed` unchanged, so no page changed when the backend arrived.
4. **Loading and error states everywhere.** Each feed goes through react-query (retries, caching, refetch interval). Components render `Loading` or `ErrorState` with a Retry button. Each page sits behind an error boundary.

## 2. Frontend (Phase 1)

```
src/
  types/data.ts            Provenance, Metric, Zone, Selection, CityAlert …
  data/cities.ts           City catalogue + analysis-grid parameters
  lib/                     geo maths (hex grid, point-in-polygon, area), formatting, seeded PRNG
  services/osm/            OSM pipeline core: geometry, Overpass client, buildings, file import, cache, view import
  services/districts.ts    Loads pipeline output (public/data/districts)
pipeline/                  Node import scripts (district boundaries)
  services/
    openMeteo.ts           Weather + CAMS air quality (+ 5×5 model-grid sampling)
    geocode.ts             Photon (OSM) place search
    simulated.ts           Deterministic synthetic traffic/energy/zones/incidents
    analysis.ts            Alert rules, insights, IDW air interpolation (rule engine)
    assistant.ts           CityTwin AI intent engine (grounded answers)
    simulationEngine.ts    What-if heuristics with explicit assumptions
  hooks/
    useCityData.ts         Single data entry point (react-query + memoised simulation)
    CityDataContext.tsx    Shares one instance app-wide
  store/useAppStore.ts     Zustand UI state (page, city, layers, selection, settings; persisted)
  components/
    layout/                Sidebar, TopBar (city, search, feed status, clock), RightPanel
    map/                   CityMap (MapLibre), mapStyle (dark OSM basemap), MapToolbar (2D/3D, layers, legend)
    charts/                Recharts wrappers (TimeChart, HBarChart)
    ui/                    Panel, Stat, KV, SourceBadge, Loading/Error, SimGate
  pages/                   Overview, MapPage (3D/Traffic/Environment/Energy), Simulation, Assistant, Reports, Settings
```

**Map.** MapLibre GL renders OpenStreetMap vector tiles (OpenMapTiles schema, served by OpenFreeMap) with a custom dark style. Buildings use `fill-extrusion` from OSM `render_height`. Runtime overlays are GeoJSON sources:

| Source | Content |
|---|---|
| `zones` | hex analysis grid → energy choropleth, AQI choropleth, hit-testing |
| `air` | CAMS model sample points → heatmap (low zoom) + labelled points |
| `traffic` | built from `querySourceFeatures` on loaded road tiles on every `idle` with a new viewport; congestion is simulated per segment |
| `incidents`, `selected` | incident points; highlight of the current selection |

The four map modules share one mounted map. Switching module swaps the floating panel and applies a layer preset (`PAGE_LAYERS`).

**Why MapLibre rather than Cesium for Phase 1:** no token is needed, vector OSM data has real coordinates, extrusions perform well, and there is a clean 2D/3D toggle. Phase 2 adds Three.js custom layers (MapLibre `CustomLayerInterface`) for detailed models. A Cesium/3D Tiles view can come later for photogrammetry.

## 3. Phase 2: OSM data and 3D detail

### 3.1 OSM import pipeline

```
                ┌──────────────── shared core (src/services/osm) ────────────────┐
                │ geometry.ts  ring assembly · multipolygons · area · centroid · │
                │              Douglas–Peucker simplification                    │
                │ overpass.ts  mirror fallback · timeout · backoff               │
                └───────┬───────────────────────────────────────┬────────────────┘
   offline (Node)       │                       browser (live)  │
pipeline/import-districts.ts                 viewImport.ts ─ IndexedDB cache (7 d)
  → public/data/districts/<city>.geojson     fileImport.ts  (.osm XML / overpass-turbo GeoJSON)
  → public/data/districts/index.json         buildings.ts   tag → use category, attributes
```

- The core modules use explicit `.ts` imports and only type-erasable TypeScript. Node 22.6+ (type stripping) runs the pipeline with `npm run import:districts [city…]` and no build step. Phase 4 points the same output at PostGIS.
- **District boundaries** are OSM `boundary=administrative` relations at a configured `admin_level` inside the city's area relation (`src/data/districtSources.ts`). The pipeline assembles rings from member ways, assigns holes, simplifies to 25 m, records area, centroid and the OSM `population` tag when present, and stamps OSM data and import timestamps.
- **Live building import** queries Overpass for `building=*` ways and multipolygon relations, plus `natural=tree` nodes, inside the visible ground area (≤ 4 km²). Results are cached in IndexedDB. Any cached area that contains the current view is reused.
- **File import** normalises OSM XML or overpass-turbo GeoJSON into Overpass-shaped elements, then reuses the same extraction.

### 3.2 Districts as analysis zones

`buildZones(city, districts)` builds zones from the imported boundaries. It falls back to the synthetic hex grid when no import exists. Geometry, area and tagged population are **real** (`populationSource: 'osm'`). Traffic, energy and green share stay simulated, scaled by each district's centrality and area. The air-quality model grid is resampled over the district extent.

### 3.3 Building attributes on vector tiles

OpenFreeMap building feature ids are `osm_id × 10 + suffix`, so `floor(id / 10)` gives the OSM way or relation id. Imported records are keyed by OSM id. On every map `idle`, newly loaded tile features with a matching record get a `use` **feature-state**. The building paint switches between a height ramp and `match(feature-state.use)` without duplicating any geometry. Clicking a building shows its OSM attributes: name, use, address, levels, tagged height, construction date, roof and material.

### 3.4 Three.js detail layer

`threeDetailLayer.ts` is a MapLibre `CustomLayerInterface` (`renderingMode: '3d'`). It renders with a `THREE.WebGLRenderer` that shares MapLibre's GL context and depth buffer, so meshes are occluded by extruded buildings. Model space is metres (x east, y up, z south) relative to a city origin. It is projected with `defaultProjectionData.mainMatrix × translate·scale·rotateX`.

| Group | Content | Provenance |
|---|---|---|
| Vegetation | instanced trunks + crowns: OSM `natural=tree` nodes plus deterministic illustrative fill inside park/wood polygons in view | API (mapped) / estimate (fill) |
| District columns | one cylinder per district; metric = population, PM2.5 (IDW), energy or traffic | depends on metric |
| Incident pulses | animated rings + pins at simulated incidents | simulated |

## 4. Phase 3: live traffic and ground-station air data

Real feeds replace simulated values wherever a public live source exists. Everything else stays simulated and labelled.

### 4.1 Coverage

| City | Traffic (`services/traffic/live.ts`) | Ground air stations (`services/air/stations.ts`) |
|---|---|---|
| Istanbul | İBB traffic index: live, European/Anatolian sides, 8-day history at 15 min → real today-vs-last-week | İBB Hava Kalitesi: 28 municipal reference stations, hourly, 48 h history |
| London | TfL Unified API: 24 strategic corridor statuses + live disruptions (points, closed street segments) | Sensor.Community (low-cost) |
| New York | NYC DOT real-time speeds: ~125 sensor links with geometry + 24 h / last-week history | OpenAQ (key) |
| Berlin | none — VIZ closures feed last updated July 2025 | Sensor.Community (~150 low-cost sensors) |
| Ankara, İzmir, Tekirdağ, Edirne, Bursa, Kocaeli, Antalya | none found | Sensor.Community where sensors exist, OpenAQ (key) |

OpenAQ v3 (all cities) is enabled by `OPENAQ_API_KEY` in `.env.local`.

### 4.2 Provenance rules

- **Measured values** use the `sensor` source: ground stations and NYC DOT speeds.
- **Values derived from a live feed** use `estimated`, with the method in the note:
  - NYC congestion % = 1 − speed ÷ the link's 24 h 90th-percentile speed. The city index is the median across links.
  - The London corridor delay index is a mean of corridor severity weights (Good 0 … Severe/Closure 100).
- The İBB traffic index is published directly, so it stays `external-api`.
- **Mixing rules:**
  - Where a live index exists it drives the city level. District traffic remains a simulated distribution scaled to it, and is labelled as such.
  - Where live segment geometry exists (NYC, London), the simulated per-road overlay is removed rather than mixed with it.
  - Live incidents replace simulated ones. Cities without a live feed keep simulated incidents.
- **Ground stations:**
  - The city summary is the median of the latest readings, preferring reference monitors over low-cost sensors.
  - Readings older than 6 h are dropped.
  - Low-cost sensors are flagged in the UI, and readings ≥ 500 µg/m³ are discarded as faults.
- **Alerts** use measured pollutant values when available and fall back to model values only for unmeasured pollutants. Every alert carries the provenance of the data that triggered it.
- **Staleness:** feeds report `asOf`. The UI shows "delayed" when data is older than 45 min (İBB) or 60 min (NYC DOT, which typically runs 1–3 h behind).

### 4.3 Proxies

`vite.config.ts` defines same-origin proxies for `npm run dev` and `npm run preview`:

| Path | Upstream | Why |
|---|---|---|
| `/proxy/ibb-traffic` | `api.ibb.gov.tr/tkmservices/...` | no CORS headers |
| `/proxy/ibb-air` | `api.ibb.gov.tr/havakalitesi/...` | duplicated `Access-Control-Allow-Origin`, which browsers reject |
| `/proxy/openaq` | `api.openaq.org` | needs `X-API-Key`; the key is injected server-side and never reaches the browser |

A static deployment returns `index.html` for these paths. `fetchJson` detects that and marks the feed "proxy not available" instead of failing. The Phase 4 backend serves the same upstreams under `/api/v1/proxy/{name}` (§5.3).

### 4.4 Implementation notes

- **İBB air API:** it samples hourly *from* `StartDate`, so the request window is aligned to whole local hours. Off-hour start times return only nulls. Times are Istanbul local and are converted with `parseLocal`.
- **NYC DOT:** `data_as_of` is New York local time without a zone. Queries are SoQL with `$where` windows in local time.
- **MapLibre worker:** it is served as a static copy (`public/vendor`, created by `pipeline/copy-vendor.mjs` before dev and build). Vite's `?worker` transform injects `/@vite/client`, which breaks inside a worker.
- **Hidden browser tabs:** they throttle `requestAnimationFrame`. A map started in a hidden tab finishes loading once the tab becomes visible.

## 5. Phase 4: FastAPI + PostGIS backend

`backend/` is a FastAPI app (`app/main.py`, factory `create_app`) on asyncpg and PostgreSQL 17 + PostGIS 3.6. It is optional: the frontend runs without it (direct mode) and switches to it when it answers (backend mode).

```
browser ──/api/v1/*, /ws/sensors──▶ FastAPI ──asyncpg──▶ PostGIS (district, sensor, reading, http_cache)
   │   (via Vite proxy in dev,          │
   │    same origin when it serves dist)└──httpx / urllib──▶ İBB · Sensor.Community · OpenAQ · Overpass
   └── direct mode: /proxy/* (Vite) + public APIs, when /api/v1/health fails
```

### 5.1 Layout

| Path | Role |
|---|---|
| `app/config.py` | Settings from env, `../.env.local` and `backend/.env` (`DATABASE_URL`, `OPENAQ_API_KEY`, `POLLER_ENABLED`, `SENSOR_POLL_SECONDS`, `CORS_ORIGINS`) |
| `app/db.py`, `app/migrations/*.sql` | Pool with JSON codecs; numbered SQL migrations tracked in `schema_migrations`; seeds `city` from `app/cities.py` (mirrors `src/config/cities.ts`) |
| `app/services/districts.py` | Loads `public/data/districts/*.geojson` (the Phase 2 pipeline output) with `ST_MakeValid(ST_GeomFromGeoJSON())`. Skipped when `metadata.importedAt` hasn't changed |
| `app/services/sensors.py` | Station adapters (İBB, Sensor.Community, OpenAQ), persistence, hourly history, poller loop |
| `app/services/ws_hub.py` | Per-city WebSocket fan-out |
| `app/upstream.py` | Shared httpx client, retry, lenient client, L1 TTL cache, Postgres cache, single-flight locks |
| `app/routers/{geo,proxy,sensors,ai}.py` | HTTP and WebSocket endpoints (`ai` since Phase 5) |
| `app/services/{anomalies,agent,ai_tools}.py` | Phase 5: anomaly detection, Claude agent loop, agent tools (§6) |
| `app/cli.py` | `migrate`, `load-districts [--force]`, `poll [city]`, `anomalies [city]` |
| `scripts/db.ps1` | Portable cluster in `backend/.pg` (`setup`, `start`, `stop`, `status`) on 127.0.0.1:54329 |
| `tests/` | pytest against the local database; upstreams are monkeypatched, so no outbound network |

### 5.2 Schema (`001_init.sql`)

- `city(id, name, country, timezone, center Point)`
- `district_import(city_id, source, unit, admin_level, osm_timestamp, imported_at, simplified_tolerance_m, loaded_at)`: provenance of each loaded boundary set
- `district(id, city_id, osm_id, name, name_en, population, population_date, wikidata, geom MultiPolygon 4326)`, unique on `(city_id, osm_id)`, GiST index
- `sensor(id, city_id, provider, grade, name, geom Point, last_seen)`, GiST index
- `reading(sensor_id, pollutant, measured_at, value)`; primary key on all three, so re-polling the same window is idempotent; pruned after 14 days
- `http_cache(key, body, content_type, stored_at, expires_at, meta)`: durable response cache (Overpass)

Areas are computed on `geography`, so km² are geodesic. Berlin comes out at 891 km², Greater London at 1,572 km² and New York at 1,214 km², within 2 % of official figures (asserted in the tests).

### 5.3 API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/health` | PostGIS version, district and reading counts, poller state, WebSocket clients, cache stats. The frontend probes this (30 s TTL) to choose its mode |
| GET | `/api/v1/cities` | Cities with centre, district count and total geodesic area |
| GET | `/api/v1/cities/{id}/districts` | `DistrictCollection` GeoJSON, `metadata.servedBy = "PostGIS"` |
| GET | `/api/v1/cities/{id}/districts/at?lon=&lat=` | District containing a point (`ST_Intersects`), 404 outside |
| GET | `/api/v1/cities/{id}/stations` | Latest `StationFeed` snapshot from the database |
| GET | `/api/v1/stations/{id}/history?hours=48` | Hourly readings of one station |
| GET | `/api/v1/proxy/{name}/{path}` | `ibb-traffic` (60 s), `ibb-air` (10 min), `openaq` (5 min; key added server-side, 503 without one). Unknown names → 404, `..` → 400. `X-Cache: HIT/MISS` |
| POST | `/api/v1/overpass` | `{query}`; `[out:json]` only. Cached 7 days in `http_cache`, tries four mirrors. `X-Cache` and `X-Overpass-Endpoint` headers |
| WS | `/ws/sensors?city=` | Sends `{type:"snapshot"}` on connect, `{type:"update"}` after each poll; answers `ping` with `pong`; 30 s heartbeat. Unknown city → close 4404. Since Phase 5 also `{type:"anomalies"}` after each scan |
| GET | `/api/v1/cities/{id}/anomalies` | Phase 5 anomaly scan (§6.1) |
| GET / POST | `/api/v1/ai/status`, `/api/v1/ai/chat` | Phase 5 CityTwin AI (§6.2); chat is 503 without `ANTHROPIC_API_KEY` |

OpenAPI docs are generated at `/docs`. When `dist/` exists, the app also serves it at `/`. `index.html` is sent with `Cache-Control: no-cache` and hashed `assets/*` as immutable, so a rebuild never leaves a browser holding an index that points at deleted chunks.

### 5.4 Caching and upstream handling

- **L1**: in-process LRU with per-entry TTL for the proxies. Only 200 responses are cached.
- **L2**: Postgres `http_cache` for Overpass, which is slow and rate-limited. It survives restarts.
- **Single-flight**: concurrent identical requests wait on one upstream call, then read the cache.
- **Lenient client**: İBB's traffic server sends a duplicated `Transfer-Encoding` header. httpx (h11) correctly rejects that as a framing error, while browsers and urllib accept it. That one upstream goes through `lenient_get` (urllib in a worker thread). It also relabels JSON bodies served as XML.

### 5.5 Sensor poller

Every `SENSOR_POLL_SECONDS` (600), `SensorService.run_forever` polls each city:

1. Fetches stations from the providers that cover the city (§4.1). İBB backfills 48 h on the first poll, then 3 h, using hour-aligned Istanbul-local windows (§4.4).
2. Upserts sensors and readings; OpenAQ values in ppm/ppb are converted to µg/m³ (`to_ugm3`).
3. Builds the city history in SQL: hourly `percentile_cont(0.5)` medians, using reference monitors when the city has any and low-cost sensors otherwise.
4. Broadcasts the new `StationFeed` to that city's WebSocket clients.

Each provider fails independently. A failure is reported in the feed's `sources` and doesn't stop the others.

### 5.6 Frontend integration

- `services/backend.ts`: `getBackend()` probes `/api/v1/health`. `upstreamBase(name)` returns `/api/v1/proxy/{name}` in backend mode, `/proxy/{name}` otherwise. All feed adapters build their URLs through it.
- `services/districts.ts` tries `/api/v1/cities/{id}/districts`, then the static GeoJSON.
- `services/osm/viewImport.ts` sends building imports to `POST /api/v1/overpass` when the backend is up, otherwise straight to the Overpass mirrors.
- `hooks/useSensorSocket.ts` writes each snapshot or update into the react-query cache (`['stations', city, 'backend']`) and reconnects with backoff. While the socket is open, station polling is turned off.
- The backend and the socket appear as feeds under **Settings → Data sources & provenance**.

In development, Vite proxies `/api` and `/ws` to `CITYTWIN_BACKEND`. If the backend stops while the page is open, Vite's WebSocket proxy logs `ECONNRESET` and the page reloads once into direct mode. This is a dev-server quirk and doesn't happen when the backend serves `dist/`.

## 6. Phase 5: CityTwin AI and anomaly detection

Both live in the backend, next to the data they use.

### 6.1 Anomaly detection (`app/services/anomalies.py`)

It runs after every poll of a city (`SensorService.detect`). The result is pushed to that city's sockets as `{type:"anomalies"}` and stored in `anomaly` (migration `002_anomaly.sql`, one row per sensor, pollutant and hour). Input: hourly means per station for PM2.5, PM10 and NO₂ over the last ~51 h, plus each station's district from a PostGIS `ST_Intersects` join.

For each pollutant, every station whose latest hour is at most 2 h old gets three scores:

| Score | Definition | Needs |
|---|---|---|
| Temporal z | `(x − median) / max(1.4826·MAD, floor)` over the station's previous 48 h | ≥ 12 hourly points |
| Spatial z | the same against the 6 nearest stations within 15 km, this hour | ≥ 4 neighbours |
| IsolationForest | `sklearn` forest (200 trees, `contamination="auto"`, fixed seed) over `[log1p(x), temporal z, spatial z]` across the city | ≥ 15 stations |

The scale floors (2 / 4 / 5 µg/m³ for PM2.5 / PM10 / NO₂) stop near-constant sensors from producing huge z-scores for small moves. A value is flagged when z ≥ 4 and it exceeds the expected value by at least 10 / 20 / 20 µg/m³. When the forest could run, it must also mark the point as an outlier. Temporal flags are *spikes*. A value that is only high relative to its neighbours is a *local hotspot*, which can mean a local source or a faulty sensor; the UI says so. Rule-based *sensor faults* (PM2.5 > 1.1 × PM10 + 2, 8 identical hours in a row, < 0 or ≥ 1000 µg/m³) and *city-wide episodes* (network median z ≥ 3 against the network's own 48 h, and above the WHO 24 h guideline) are reported separately.

Severity: *critical* requires a reference monitor at ≥ 5× the WHO 24 h guideline. *Warning* means z ≥ 5, ≥ 2× the guideline, or the critical level on a low-cost sensor. Everything else is *info*. Only warning, critical and episodes become dashboard alerts.

Every response carries its method, its thresholds and a per-pollutant coverage block (stations scored, how many had history and neighbours, whether the forest ran). A city with thin data therefore shows what was *not* checked. Known gaps: no diurnal or weekly seasonality model yet, because the 48 h MAD absorbs the daily cycle and makes the thresholds conservative. Dips are not flagged. Thresholds are expert-set, not fitted, because there is no labelled ground truth.

`GET /api/v1/cities/{id}/anomalies[?refresh=true]` returns the latest scan; `python -m app.cli anomalies [city]` runs one from the shell.

### 6.2 CityTwin AI (`app/services/agent.py`, `ai_tools.py`, `routers/ai.py`)

`POST /api/v1/ai/chat {city, messages}` streams server-sent events. The backend runs a manual tool-use loop over the Anthropic Messages API (Python SDK, `client.beta.messages.stream`):

- **Model**: `claude-opus-5-5`, adaptive thinking, `output_config.effort` from `AI_EFFORT` (default `medium`), `max_tokens` 16k per step, at most `AI_MAX_STEPS` tool rounds.
- **Refusals**: server-side fallback is enabled (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`). A safety decline is retried on Anthropic's recommended model. The UI drops the declined partial text and notes the switch. If the whole chain refuses, a `refusal` event is shown.
- **Prompt caching**: a frozen system prompt plus a static tool list, with top-level `cache_control`. The per-request city and current time go into the newest user turn, so the prefix stays cacheable.
- **Append-only history**: within a question, each assistant turn (thinking blocks included) is appended exactly as returned, followed by one user turn holding all tool results. Across questions, the client sends plain text only: questions and the final answers.
- **Tool inputs**: tools stream their inputs eagerly (`eager_input_streaming`), so `ai_tools.validate` checks every input against its closed schema (required fields, types, enums, ranges, no extra fields) before running anything. Invalid input goes back to the model as an `is_error` result. Unparseable JSON re-issues the step (at most twice).
- **Tool results**: JSON, each with a `provenance` object, capped at 24k characters (the model is asked to narrow the query instead of receiving a truncated result).

| Tool | Data |
|---|---|
| `get_city_overview` | district count/area, network medians, providers' state, anomaly count, and the list of modules that are simulated |
| `list_districts`, `find_district` | OSM districts in PostGIS (geodesic areas, OSM population tag) |
| `get_air_stations`, `get_air_by_district` | latest measured values; per-district median/max via a station→district spatial join |
| `get_air_history`, `get_station_history` | hourly network medians / one station's hourly means from `reading` |
| `get_anomalies` | §6.1 result |
| `get_weather` | Open-Meteo forecast + CAMS air model (model output, 10 min cache) |
| `get_traffic` | İBB index (Istanbul), TfL corridors and disruptions (London), NYC DOT link speeds (New York); other cities report "no feed" |

All tools are read-only and take enum-checked city ids. None of them accepts SQL, URLs or file paths. The system prompt requires every figure to come from a tool result. Sensor, model and estimate figures must be kept apart. Simulated modules (energy, noise, most per-road traffic) are declined explicitly rather than analysed. Station names and other upstream strings reach the model only as data inside tool results.

Events: `text`, `tool_start`, `tool_use`, `tool_result` (with provenance), `fallback`, `retry`, `refusal`, `error`, `done` (model and token usage, including cache reads). `GET /api/v1/ai/status`, and `ai` in `/api/v1/health`, report whether a key is configured. The frontend (`pages/AssistantPage.tsx`, `services/aiChat.ts`) shows tool chips, renders a safe Markdown subset (React elements only), collects source badges from the tool provenance, and keeps the rule-based engine as the fallback and as an explicit "Rules" mode.

Tests (`tests/test_ai.py`, `tests/test_anomalies.py`) drive the loop with a scripted fake client, so they make no Claude calls. They check the request shape (model, thinking, effort, fallbacks), the append-only history, input validation, refusals and the anomaly rules on synthetic networks.

## 7. Target system (Phases 6–7)

```
            ┌──────────── React client ────────────┐
            │ MapLibre + Three.js custom layers     │
            │ react-query ⇄ REST   WebSocket ⇄ live │
            └───────────────┬───────────────────────┘
                            │ HTTPS / WSS
┌───────────────────────────┴──────────────────────────────┐
│ FastAPI gateway  (/api/v1/…, /ws/sensors)                 │
│  routers: geo · environment · traffic · energy · sensors  │
│           simulation · ai · reports · auth                │
│  pydantic schemas mirror src/types/data.ts (Provenance!)  │
└──────┬──────────────┬──────────────┬──────────────┬──────┘
       │              │              │              │
 PostgreSQL+PostGIS  Ingestion workers  Simulation   AI service
 (geo, time series   (OSM/Overpass,     workers      (anomaly detection,
  via TimescaleDB)    Open-Meteo,       (traffic     LLM w/ tool calls
                      OpenAQ, IoT MQTT) assignment,  over the same API)
                                        energy)
```

### Proposed REST surface

| Module | Endpoints |
|---|---|
| Geo | `GET /cities`, `GET /cities/{id}/zones`, `GET /cities/{id}/buildings?bbox=`, `POST /imports/osm` |
| Environment | `GET /cities/{id}/environment/current`, `GET …/history?metric=pm25&from=&to=` |
| Traffic | `GET /cities/{id}/traffic/segments?bbox=`, `GET …/history`, `GET …/incidents` |
| Energy | `GET /cities/{id}/energy/zones`, `GET …/buildings/{id}`, `GET …/anomalies` |
| Sensors | `GET /sensors`, `POST /sensors/{id}/readings`, `WS /ws/sensors?city=` |
| Simulation | `POST /simulations` (scenario) → `GET /simulations/{id}` (result + model metadata) |
| AI | `POST /ai/ask` (grounded with retrieved metrics), `POST /ai/report` |

Every response object includes `source`, `provider` and `observed_at`. Validation is done with Pydantic. Errors use RFC 7807 problem+json.

### Database sketch (later phases; §5.2 is what exists now)

- `city(id, name, geom MultiPolygon, tz)`
- `zone(id, city_id, name, geom Polygon)`
- `building(id, osm_id, city_id, geom Polygon, height_m, levels, use)`
- `road_segment(id, osm_id, city_id, geom LineString, class, lanes, speed_limit)`
- `sensor(id, kind, geom Point, provider, source)`
- `reading(sensor_id, metric, value, unit, observed_at)` (hypertable)
- `simulation(id, city_id, input jsonb, result jsonb, model_version, created_at)`

## 8. Phase roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Frontend, navigation, dashboard, interactive map | **done** |
| 2 | OSM import pipeline, real district boundaries, building attributes, Three.js detail layers | **done** (terrain deferred) |
| 3 | Live traffic (İBB, TfL, NYC DOT) and ground air stations (İBB, Sensor.Community, OpenAQ) | **done** (noise sensors: no public feed found) |
| 4 | FastAPI + PostGIS backend, cached upstream proxies, WebSocket live sensors | **done** (auth moved to Phase 7) |
| 5 | CityTwin AI: LLM with tool calls over the API, ML anomaly detection | **done** for air-quality sensors (energy anomalies stay rule-based on simulated data until a real feed exists) |
| 6 | Simulation engine: traffic assignment, microclimate and energy models with validation metadata | planned (heuristic preview in place) |
| 7 | Auth, tests, performance, CI/CD, deployment | planned (backend pytest suite in place) |

## 9. Known limitations

- Anomaly detection has no seasonality model and no labelled ground truth (§6.1). Cities need about 12 h of polling before temporal scores exist; until then, only spatial and IsolationForest checks run, and the coverage line says so.
- CityTwin AI needs an Anthropic API key on the backend and costs per question (typically several tool rounds). It sees only what its tools expose: no simulated data, no map viewport, no OSM building attributes yet.
- The regional air model is ~11–45 km resolution. Ground stations now provide measured values in Istanbul, Berlin and London (and in all cities with an OpenAQ key).
- Live traffic covers Istanbul, London and New York only. Traffic in Berlin and in the other Turkish cities stays simulated. Istanbul publishes only a city-wide index, so its per-road colours stay simulated.
- İBB and OpenAQ need a proxy: the Vite dev/preview server or the Phase 4 backend. Plain static hosting gets neither.
- Energy, green share and noise remain synthetic or estimated (no open feeds).
- Districts come from OSM admin boundaries. OSM tags population for only some districts; the rest is simulated and marked as such.
- Live building import depends on public Overpass servers, which are often saturated. The client retries across four mirrors and caches results, but an import can still fail during peak load.
- Many OSM buildings are tagged only `building=yes`, so a large share falls into “Other”. This reflects the source data.
- 3D tree fill inside parks is illustrative, not surveyed. Only OSM-mapped trees are real positions.
- Public endpoints (Open-Meteo, Photon, OpenFreeMap) are used directly from the browser and have fair-use limits. The Phase 4 backend does not proxy these yet.
