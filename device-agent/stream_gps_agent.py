#!/usr/bin/env python3
"""Standalone Stream GPS agent. It does not import or modify BelaUI."""

import argparse, base64, hashlib, hmac, html, json, os, re, secrets, subprocess, threading, time, urllib.error, urllib.request, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CONFIG_PATH = Path('/etc/stream-gps-device/config.json')
QUEUE_PATH = Path('/var/lib/stream-gps-device/queue.jsonl')
STATUS = {'started_at': time.time(), 'modem': None, 'gps_fix': False, 'last_position': None, 'last_upload': None, 'last_error': None, 'queue_size': 0}
LOCK = threading.Lock()

def load_config():
    with CONFIG_PATH.open(encoding='utf-8') as handle: return json.load(handle)

def save_config(config):
    temporary = CONFIG_PATH.with_suffix('.tmp')
    temporary.write_text(json.dumps(config, indent=2) + '\n', encoding='utf-8')
    os.chmod(temporary, 0o600); temporary.replace(CONFIG_PATH)

def run(*command):
    return subprocess.run(command, text=True, capture_output=True, timeout=20, check=False)

def find_modem(config):
    configured = str(config.get('modem_id', 'auto'))
    if configured != 'auto': return configured
    result = run('mmcli', '-L')
    matches = re.findall(r'/Modem/(\d+)', result.stdout)
    return matches[0] if matches else None

def enable_gps(modem):
    run('mmcli', '-m', modem, '--location-enable-gps-raw')
    run('mmcli', '-m', modem, '--location-enable-gps-nmea')

def parse_mmcli(text):
    values = {}
    for line in text.splitlines():
        if ':' not in line: continue
        key, value = line.split(':', 1); values[key.strip()] = value.strip().strip("'")
    def number(*names):
        for name in names:
            raw = values.get(name)
            if raw and raw.lower() not in ('--', 'unknown'):
                match = re.search(r'-?\d+(?:\.\d+)?', raw)
                if match:
                    try: return float(match.group())
                    except ValueError: pass
        return None
    def nmea_coordinate(raw, hemisphere):
        if not raw: return None
        value = float(raw); degrees = int(value // 100); result = degrees + (value - degrees * 100) / 60
        return -result if hemisphere in ('S', 'W') else result
    nmea = {}
    for sentence in re.findall(r'\$[^\r\n\'"\]]+', text):
        fields = sentence.split('*', 1)[0].split(','); kind = fields[0][-3:]
        try:
            if kind == 'RMC' and len(fields) >= 9 and fields[2] == 'A':
                nmea['latitude'] = nmea_coordinate(fields[3], fields[4]); nmea['longitude'] = nmea_coordinate(fields[5], fields[6])
                if fields[7]: nmea['speed'] = float(fields[7]) * 1.852
                if fields[8]: nmea['heading'] = float(fields[8]) % 360
            elif kind == 'GGA' and len(fields) >= 10 and fields[6] not in ('', '0'):
                nmea.setdefault('latitude', nmea_coordinate(fields[2], fields[3])); nmea.setdefault('longitude', nmea_coordinate(fields[4], fields[5]))
                if fields[7]: nmea['satellites'] = int(fields[7])
                if fields[9]: nmea['altitude'] = float(fields[9])
        except (ValueError, IndexError): pass
    latitude = number('modem.location.gps.latitude')
    longitude = number('modem.location.gps.longitude')
    latitude = latitude if latitude is not None else nmea.get('latitude'); longitude = longitude if longitude is not None else nmea.get('longitude')
    if latitude is None or longitude is None: return None
    position = {'latitude': latitude, 'longitude': longitude, 'recorded_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    mappings = {'altitude': ('modem.location.gps.altitude',), 'speed': ('modem.location.gps.speed',),
                'heading': ('modem.location.gps.heading',), 'accuracy': ('modem.location.gps.accuracy',),
                'satellites': ('modem.location.gps.satellites',)}
    for target, names in mappings.items():
        value = number(*names)
        if value is None: value = nmea.get(target)
        if value is not None: position[target] = int(value) if target == 'satellites' else value
    return position

def read_position(modem):
    result = run('mmcli', '-K', '-m', modem, '--location-get')
    if result.returncode: raise RuntimeError(result.stderr.strip() or 'mmcli location request failed')
    return parse_mmcli(result.stdout)

def queue_items():
    if not QUEUE_PATH.exists(): return []
    cutoff = time.time() - 86400
    items = []
    for line in QUEUE_PATH.read_text(encoding='utf-8').splitlines():
        try:
            item = json.loads(line)
            if item.get('_queued_at', 0) >= cutoff: items.append(item)
        except (ValueError, TypeError): pass
    return items[-5000:]

def write_queue(items):
    QUEUE_PATH.parent.mkdir(parents=True, exist_ok=True)
    QUEUE_PATH.write_text(''.join(json.dumps(item, separators=(',', ':')) + '\n' for item in items[-5000:]), encoding='utf-8')
    os.chmod(QUEUE_PATH, 0o600)
    with LOCK: STATUS['queue_size'] = len(items[-5000:])

def upload(config, position):
    body = json.dumps({key: value for key, value in position.items() if not key.startswith('_')}).encode()
    request = urllib.request.Request(config['api_url'].rstrip('/') + '/api/v1/gps/update', data=body, method='POST', headers={
        'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config['device_key'],
        'X-Device-Id': config['device_id'], 'X-Request-Timestamp': str(int(time.time())),
        'X-Request-Nonce': str(uuid.uuid4()), 'User-Agent': 'Stream-GPS-Device/1.0'
    })
    with urllib.request.urlopen(request, timeout=15) as response:
        if response.status not in (200, 201): raise RuntimeError('API returned HTTP ' + str(response.status))

def tracking_loop():
    gps_enabled_for = None
    while True:
        try:
            config = load_config(); modem = find_modem(config)
            if modem is None: raise RuntimeError('No ModemManager modem detected')
            if modem != gps_enabled_for: enable_gps(modem); gps_enabled_for = modem
            with LOCK: STATUS['modem'] = modem
            position = read_position(modem)
            if position is None:
                with LOCK: STATUS['gps_fix'] = False; STATUS['last_error'] = 'Waiting for GPS fix'
                time.sleep(max(2, int(config.get('interval_seconds', 2)))); continue
            with LOCK: STATUS['gps_fix'] = True; STATUS['last_position'] = position; STATUS['last_error'] = None
            pending = queue_items(); pending.append(dict(position, _queued_at=time.time()))
            remaining = []
            for index, item in enumerate(pending):
                try: upload(config, item)
                except Exception as error:
                    remaining = pending[index:]
                    with LOCK: STATUS['last_error'] = str(error)
                    break
                else:
                    with LOCK: STATUS['last_upload'] = time.time(); STATUS['last_error'] = None
            write_queue(remaining)
        except Exception as error:
            with LOCK: STATUS['gps_fix'] = False; STATUS['last_error'] = str(error)
        time.sleep(max(0.5, min(10, float(load_config().get('interval_seconds', 2)))))

def verify_password(config, password):
    try:
        salt = base64.b64decode(config['ui_password_salt']); expected = base64.b64decode(config['ui_password_hash'])
        actual = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 200000)
        return hmac.compare_digest(actual, expected)
    except Exception: return False

class Handler(BaseHTTPRequestHandler):
    csrf = secrets.token_urlsafe(24)
    def authorized(self):
        header = self.headers.get('Authorization', '')
        if not header.startswith('Basic '): return False
        try: username, password = base64.b64decode(header[6:]).decode().split(':', 1)
        except Exception: return False
        return username == 'admin' and verify_password(load_config(), password)
    def require_auth(self):
        if self.authorized(): return True
        self.send_response(401); self.send_header('WWW-Authenticate', 'Basic realm="Stream GPS device"'); self.end_headers(); return False
    def respond(self, status, body, content_type='text/html; charset=utf-8'):
        data = body.encode(); self.send_response(status); self.send_header('Content-Type', content_type); self.send_header('Content-Length', str(len(data))); self.send_header('Cache-Control', 'no-store'); self.send_header('X-Content-Type-Options', 'nosniff'); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        if not self.require_auth(): return
        if self.path == '/api/status':
            with LOCK: payload = dict(STATUS)
            self.respond(200, json.dumps(payload), 'application/json'); return
        config = load_config(); status = dict(STATUS)
        page = f'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Stream GPS Device</title><style>body{{font:16px system-ui;background:#0b1120;color:#e5edf7;max-width:760px;margin:30px auto;padding:16px}}section{{background:#121b2b;border:1px solid #28364b;border-radius:12px;padding:20px;margin:16px 0}}input{{width:100%;box-sizing:border-box;padding:10px;margin:5px 0 14px;background:#0f1726;color:white;border:1px solid #44536a;border-radius:7px}}button{{padding:10px 15px;background:#1f6feb;color:white;border:0;border-radius:7px}}.ok{{color:#35d39a}}.bad{{color:#f97066}}code{{overflow-wrap:anywhere}}</style></head><body><h1>Stream GPS Device</h1><section><h2>Status</h2><p>Modem: <b>{html.escape(str(status['modem'] or 'not detected'))}</b></p><p>GPS fix: <b class="{'ok' if status['gps_fix'] else 'bad'}">{'yes' if status['gps_fix'] else 'no'}</b></p><p>Queued points: <b>{status['queue_size']}</b></p><p>Last error: <code>{html.escape(str(status['last_error'] or 'none'))}</code></p></section><section><h2>Configuration</h2><form method="post" action="/save"><input type="hidden" name="csrf" value="{self.csrf}"><label>Platform URL</label><input name="api_url" value="{html.escape(config['api_url'])}" required><label>Device ID</label><input name="device_id" value="{html.escape(config['device_id'])}" required><label>New device key (leave empty to keep current)</label><input name="device_key" type="password"><label>Update interval in seconds (0.5–10)</label><input name="interval_seconds" type="number" min="0.5" max="10" step="0.5" value="{float(config.get('interval_seconds',2)):g}"><label>Modem ID (`auto` recommended)</label><input name="modem_id" value="{html.escape(str(config.get('modem_id','auto')))}"><button>Save configuration</button></form></section></body></html>'''
        self.respond(200, page)
    def do_POST(self):
        if not self.require_auth(): return
        if self.path != '/save': self.respond(404, 'Not found'); return
        from urllib.parse import parse_qs
        length = min(int(self.headers.get('Content-Length', '0')), 20000); form = parse_qs(self.rfile.read(length).decode())
        if form.get('csrf', [''])[0] != self.csrf: self.respond(403, 'Invalid form token'); return
        config = load_config(); interval = float(form.get('interval_seconds', ['2'])[0]); api_url = form.get('api_url', [''])[0].rstrip('/')
        if not 0.5 <= interval <= 10: self.respond(400, 'Interval must be between 0.5 and 10 seconds'); return
        if not api_url.startswith(('http://', 'https://')): self.respond(400, 'Platform URL must begin with http:// or https://'); return
        config.update(api_url=api_url, device_id=form.get('device_id', [''])[0], interval_seconds=interval, modem_id=form.get('modem_id', ['auto'])[0])
        if form.get('device_key', [''])[0]: config['device_key'] = form['device_key'][0]
        save_config(config); self.send_response(303); self.send_header('Location', '/'); self.end_headers()
    def log_message(self, fmt, *args): print('web:', fmt % args)

def diagnostic():
    config = load_config(); modem = find_modem(config)
    checks = [('Configuration', bool(config.get('api_url') and config.get('device_id') and config.get('device_key'))), ('ModemManager', run('mmcli', '-L').returncode == 0), ('Modem detected', modem is not None)]
    position = None
    if modem is not None:
        enable_gps(modem)
        try: position = read_position(modem)
        except Exception: pass
    checks.append(('GPS fix', position is not None))
    api_ok = False
    if position:
        try: upload(config, position); api_ok = True
        except Exception as error: print('[FAIL] API upload:', error)
    checks.append(('Authenticated API upload', api_ok))
    for name, passed in checks: print(('[OK]   ' if passed else '[FAIL] ') + name)
    return 0 if all(value for _, value in checks) else 1

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('command', nargs='?', default='run', choices=['run','status','test','config'])
    args = parser.parse_args()
    if args.command == 'status':
        print(json.dumps(STATUS, indent=2)); return
    if args.command == 'test': raise SystemExit(diagnostic())
    if args.command == 'config':
        config = load_config(); config['device_key'] = '***hidden***'; print(json.dumps(config, indent=2)); return
    threading.Thread(target=tracking_loop, daemon=True).start()
    config = load_config(); ThreadingHTTPServer((config.get('ui_bind', '0.0.0.0'), int(config.get('ui_port', 26666))), Handler).serve_forever()

if __name__ == '__main__': main()
