UPDATE overlays
SET config = jsonb_set(config, '{mapTheme}', '"night"'::jsonb)
WHERE config->>'mapTheme' = 'dark';
