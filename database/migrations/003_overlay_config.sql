ALTER TABLE overlays
  ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{
    "mapTheme": "standard",
    "textTheme": "glass",
    "textColor": "#ffffff",
    "fontFamily": "monospace",
    "mapShape": "round",
    "mapSize": 360,
    "borderColor": "#ffffff",
    "autoZoom": true,
    "minSpeed": 0,
    "maxSpeed": 120,
    "maxZoom": 16,
    "minZoom": 10,
    "stats": {"speed": true, "direction": true, "altitude": false, "accuracy": false, "gpsSignal": false, "localTime": true, "maxSpeed": false, "avgSpeed": false, "tripDistance": false},
    "statsPosition": "below-map",
    "statsTextSize": 14
  }'::jsonb;
