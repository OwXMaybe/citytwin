-- Phase 5: anomalies found in measured sensor readings (one row per sensor, pollutant and hour).
CREATE TABLE anomaly (
    sensor_id     text NOT NULL REFERENCES sensor (id) ON DELETE CASCADE,
    pollutant     text NOT NULL,
    hour          timestamptz NOT NULL,           -- hourly bucket the flagged value belongs to
    city_id       text NOT NULL REFERENCES city (id) ON DELETE CASCADE,
    kind          text NOT NULL,                  -- spike | local-hotspot | sensor-fault
    severity      text NOT NULL,                  -- info | warning | critical
    value         double precision NOT NULL,
    expected      double precision,
    z_temporal    double precision,
    z_spatial     double precision,
    if_score      double precision,
    detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
    detected_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (sensor_id, pollutant, hour)
);
CREATE INDEX anomaly_city_time_idx ON anomaly (city_id, hour DESC);
