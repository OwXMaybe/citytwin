-- CityTwin core schema (PostGIS). Applied by app.db.migrate().
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE city (
    id        text PRIMARY KEY,
    name      text NOT NULL,
    country   text NOT NULL,
    timezone  text NOT NULL,
    center    geometry(Point, 4326) NOT NULL
);

-- One row per imported district file (provenance of the boundary set).
CREATE TABLE district_import (
    city_id                text PRIMARY KEY REFERENCES city (id) ON DELETE CASCADE,
    source                 text NOT NULL,
    unit                   text NOT NULL,
    admin_level            integer NOT NULL,
    osm_timestamp          timestamptz,
    imported_at            timestamptz NOT NULL,
    simplified_tolerance_m real,
    loaded_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE district (
    id              bigserial PRIMARY KEY,
    city_id         text NOT NULL REFERENCES city (id) ON DELETE CASCADE,
    osm_id          bigint NOT NULL,
    name            text NOT NULL,
    name_en         text,
    population      integer,
    population_date text,
    wikidata        text,
    geom            geometry(MultiPolygon, 4326) NOT NULL,
    UNIQUE (city_id, osm_id)
);
CREATE INDEX district_geom_idx ON district USING gist (geom);

-- Ground air-quality stations seen by the sensor poller.
CREATE TABLE sensor (
    id          text PRIMARY KEY,               -- provider-prefixed, e.g. "ibb-<uuid>"
    city_id     text NOT NULL REFERENCES city (id) ON DELETE CASCADE,
    provider    text NOT NULL,                  -- ibb | sensor.community | openaq
    grade       text NOT NULL,                  -- reference | low-cost
    name        text NOT NULL,
    geom        geometry(Point, 4326) NOT NULL,
    last_seen   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sensor_geom_idx ON sensor USING gist (geom);
CREATE INDEX sensor_city_idx ON sensor (city_id);

CREATE TABLE reading (
    sensor_id    text NOT NULL REFERENCES sensor (id) ON DELETE CASCADE,
    pollutant    text NOT NULL,                 -- pm25 | pm10 | no2 | o3 | so2 | co   (µg/m³)
    measured_at  timestamptz NOT NULL,
    value        double precision NOT NULL,
    PRIMARY KEY (sensor_id, pollutant, measured_at)
);
CREATE INDEX reading_time_idx ON reading (measured_at);

-- Durable upstream response cache (Overpass imports are expensive and fair-use).
CREATE TABLE http_cache (
    key           text PRIMARY KEY,
    body          bytea NOT NULL,
    content_type  text NOT NULL,
    stored_at     timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    meta          jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX http_cache_expiry_idx ON http_cache (expires_at);
