#!/usr/bin/env python3
"""Standalone Stream GPS agent. It does not import or modify BelaUI."""

import argparse, base64, hashlib, hmac, html, json, os, re, secrets, shutil, subprocess, tempfile, threading, time, urllib.error, urllib.request, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CONFIG_PATH = Path('/etc/stream-gps-device/config.json')
QUEUE_PATH = Path('/var/lib/stream-gps-device/queue.jsonl')
STATUS = {'started_at': time.time(), 'modem': None, 'gps_fix': False, 'last_position': None, 'last_upload': None, 'last_error': None, 'queue_size': 0}
LOCK = threading.Lock()
DEFAULT_UPDATE_BASE = 'https://raw.githubusercontent.com/Mi3czu/Stream_GPS/main/device-agent'

def load_config():
    with CONFIG_PATH.open(encoding='utf-8') as handle: return json.load(handle)

def save_config(config):
    temporary = CONFIG_PATH.with_suffix('.tmp')
    temporary.write_text(json.dumps(config, indent=2) + '\n', encoding='utf-8')
    os.chmod(temporary, 0o600); temporary.replace(CONFIG_PATH)

def configured(config):
    return bool(str(config.get('api_url', '')).strip() and str(config.get('device_id', '')).strip() and str(config.get('device_key', '')).strip())

def current_version():
    try: return (Path(__file__).resolve().parent / 'VERSION').read_text(encoding='utf-8').strip()
    except OSError: return '0.0.0'

def version_tuple(value):
    match = re.fullmatch(r'(\d+)\.(\d+)\.(\d+)', str(value).strip())
    if not match: raise ValueError('Invalid release version')
    return tuple(int(part) for part in match.groups())

def update_base(config=None):
    base = (config or load_config()).get('update_base', DEFAULT_UPDATE_BASE).rstrip('/')
    if not base.startswith('https://'): raise ValueError('Update URL must use HTTPS')
    return base

def download(url, timeout=20):
    request = urllib.request.Request(url, headers={'User-Agent': 'Stream-GPS-Device-Updater/1.0'})
    with urllib.request.urlopen(request, timeout=timeout) as response: return response.read()

def check_update(config=None):
    available = download(update_base(config) + '/VERSION').decode('utf-8').strip()
    version_tuple(available)
    installed = current_version()
    return {'installed': installed, 'available': available, 'update_available': version_tuple(available) > version_tuple(installed)}

def apply_update():
    config = load_config(); base = update_base(config); release = check_update(config)
    if not release['update_available']:
        print('No update available'); return
    names = ['stream_gps_agent.py', 'stream-gps-device', 'stream-gps-device.service', 'VERSION']
    install_dir = Path('/opt/stream-gps-device'); backup = Path('/var/backups/stream-gps-device') / ('auto-update-' + time.strftime('%Y%m%d-%H%M%S'))
    with tempfile.TemporaryDirectory(prefix='.update-', dir=install_dir) as directory:
        staging = Path(directory); manifest_bytes = download(base + '/checksums.sha256'); (staging / 'checksums.sha256').write_bytes(manifest_bytes)
        expected = {}
        for line in manifest_bytes.decode('utf-8').splitlines():
            checksum, name = line.split(None, 1); expected[name.strip()] = checksum.lower()
        for name in names:
            data = download(base + '/' + name)
            if name not in expected or hashlib.sha256(data).hexdigest() != expected[name]: raise RuntimeError('Checksum verification failed for ' + name)
            (staging / name).write_bytes(data)
        backup.mkdir(parents=True, exist_ok=False)
        for name in names:
            source = install_dir / name
            if source.exists(): shutil.copy2(source, backup / name)
        service_path = Path('/etc/systemd/system/stream-gps-device.service')
        if service_path.exists(): shutil.copy2(service_path, backup / 'installed.service')
        command_paths = {
            'installed-agent': Path('/usr/local/bin/stream-gps-agent'),
            'installed-command': Path('/usr/local/bin/stream-gps-device'),
        }
        for backup_name, command_path in command_paths.items():
            if command_path.exists(): shutil.copy2(command_path, backup / backup_name)
        try:
            for name in ('stream_gps_agent.py', 'stream-gps-device', 'VERSION'):
                shutil.copy2(staging / name, install_dir / name)
            os.chmod(install_dir / 'stream_gps_agent.py', 0o755); os.chmod(install_dir / 'stream-gps-device', 0o755)
            shutil.copy2(staging / 'stream-gps-device.service', install_dir / 'stream-gps-device.service')
            shutil.copy2(staging / 'stream-gps-device.service', service_path)
            shutil.copy2(staging / 'stream_gps_agent.py', command_paths['installed-agent'])
            shutil.copy2(staging / 'stream-gps-device', command_paths['installed-command'])
            os.chmod(command_paths['installed-agent'], 0o755); os.chmod(command_paths['installed-command'], 0o755)
            subprocess.run(['systemctl', 'daemon-reload'], check=True)
            subprocess.run(['systemctl', 'restart', 'stream-gps-device'], check=True)
            time.sleep(3)
            if subprocess.run(['systemctl', 'is-active', '--quiet', 'stream-gps-device']).returncode != 0: raise RuntimeError('Updated service did not become active')
            print('Updated Stream GPS Device to ' + release['available'])
        except Exception:
            for name in ('stream_gps_agent.py', 'stream-gps-device', 'VERSION'):
                if (backup / name).exists(): shutil.copy2(backup / name, install_dir / name)
            if (backup / 'installed.service').exists(): shutil.copy2(backup / 'installed.service', service_path)
            for backup_name, command_path in command_paths.items():
                if (backup / backup_name).exists(): shutil.copy2(backup / backup_name, command_path)
            subprocess.run(['systemctl', 'daemon-reload'], check=False); subprocess.run(['systemctl', 'restart', 'stream-gps-device'], check=False)
            raise

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

def device_api(config, method='GET', payload=None):
    body = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(config['api_url'].rstrip('/') + '/api/v1/device/public-sharing', data=body, method=method, headers={
        'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config['device_key'],
        'X-Device-Id': config['device_id'], 'X-Request-Timestamp': str(int(time.time())),
        'X-Request-Nonce': str(uuid.uuid4()), 'User-Agent': 'Stream-GPS-Device/1.0'
    })
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read().decode('utf-8'))

def connection_candidate(api_url, device_id, device_key, config):
    return {**config, 'api_url': api_url.strip().rstrip('/'), 'device_id': device_id.strip(), 'device_key': device_key.strip()}

def validate_connection(api_url, device_id, device_key, config):
    candidate = connection_candidate(api_url, device_id, device_key, config)
    if not candidate['api_url'].startswith(('http://', 'https://')):
        raise ValueError('Platform URL must begin with http:// or https://')
    if not candidate['device_id'] or not candidate['device_key']:
        raise ValueError('Device ID and device key are required')
    try:
        device_api(candidate)
    except urllib.error.HTTPError as error:
        if error.code in (401, 403): raise PermissionError('Invalid device ID or device key') from error
        raise RuntimeError('Platform returned HTTP ' + str(error.code)) from error
    return candidate

def tracking_loop():
    gps_enabled_for = None
    while True:
        try:
            config = load_config()
            if not configured(config):
                with LOCK: STATUS['last_error'] = 'Not connected to Stream GPS. Complete setup in the local panel.'
                time.sleep(2); continue
            modem = find_modem(config)
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
    def redirect_home(self):
        self.send_response(303); self.send_header('Location', '/'); self.send_header('Cache-Control', 'no-store'); self.end_headers()
    def setup_page(self, message=''):
        notification = f'<p class="notice">{html.escape(message)}</p>' if message else ''
        return f'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect Stream GPS</title><style>body{{font:16px system-ui;background:#0b1120;color:#e5edf7;max-width:760px;margin:30px auto;padding:16px}}section{{background:#121b2b;border:1px solid #28364b;border-radius:12px;padding:20px;margin:16px 0}}input{{width:100%;box-sizing:border-box;padding:10px;margin:5px 0 14px;background:#0f1726;color:white;border:1px solid #44536a;border-radius:7px}}button{{padding:10px 15px;background:#1f6feb;color:white;border:0;border-radius:7px;margin-right:8px;cursor:pointer}}button:disabled{{opacity:.55;cursor:not-allowed}}.secondary{{background:#28364b}}.ok{{color:#35d39a}}.error{{background:#4b2028;border-radius:8px;color:#ffb4ab;padding:10px 12px}}.notice{{background:#17365c;border-radius:8px;color:#cbe3ff;padding:10px 12px}}.key-row{{display:flex;gap:8px}}.key-row input{{margin-bottom:14px}}.key-row button{{height:42px;margin-top:5px;white-space:nowrap}}.hint{{color:#aab9cc;font-size:.9em}}</style></head><body><h1>Connect Stream GPS</h1><section><h2>Finish device setup</h2><p>Enter the credentials from your Stream GPS <b>Devices</b> page. The agent saves them only after the platform accepts them.</p>{notification}<form id="connect-form" method="post" action="/connect"><input type="hidden" name="csrf" value="{self.csrf}"><label>Platform URL</label><input name="api_url" placeholder="https://stream-gps.example" inputmode="url" required><label>Device ID</label><input name="device_id" placeholder="BELABOX_7522" required><label>Device key</label><div class="key-row"><input id="device-key" name="device_key" type="password" autocomplete="off" required><button class="secondary" id="toggle-key" type="button">Show</button></div><p id="trim-notice" class="notice" hidden>Leading or trailing spaces were removed before testing.</p><button id="test-button" class="secondary" type="button">Test connection</button><button id="connect-button" type="submit" disabled>Save and connect</button><p id="result" aria-live="polite"></p></form></section><section><h2>What happens next</h2><p>After a successful connection, the agent starts GPS uploads. You can then change the upload interval and modem settings here.</p><p class="hint">The device key remains hidden after saving. To retrieve it later, use <b>Your keys</b> on the device page in Stream GPS.</p></section><script>const form=document.getElementById('connect-form'),key=document.getElementById('device-key'),notice=document.getElementById('trim-notice'),result=document.getElementById('result'),save=document.getElementById('connect-button');function clean(){{let changed=false;for(const input of form.querySelectorAll('input[name="api_url"],input[name="device_id"],input[name="device_key"]')){{const value=input.value.trim();if(value!==input.value){{input.value=value;changed=true}}}}notice.hidden=!changed}}document.getElementById('toggle-key').onclick=()=>{{key.type=key.type==='password'?'text':'password';document.getElementById('toggle-key').textContent=key.type==='password'?'Show':'Hide'}};document.getElementById('test-button').onclick=async()=>{{clean();result.className='notice';result.textContent='Testing connection…';save.disabled=true;try{{const response=await fetch('/test-connection',{{method:'POST',body:new FormData(form)}});const payload=await response.json();result.className=response.ok?'ok':'error';result.textContent=payload.message;save.disabled=!response.ok}}catch(error){{result.className='error';result.textContent='Unable to test the connection.'}}}};form.addEventListener('submit',clean);</script></body></html>'''
    def do_GET(self):
        if not self.require_auth(): return
        if self.path == '/api/status':
            with LOCK: payload = dict(STATUS)
            self.respond(200, json.dumps(payload), 'application/json'); return
        config = load_config()
        if not configured(config): self.respond(200, self.setup_page()); return
        status = dict(STATUS); update = status.get('update_check'); installed = current_version()
        try:
            sharing = device_api(config).get('sharing') or {}; sharing_error = None
        except Exception as error:
            sharing = {}; sharing_error = str(error)
        sharing_enabled = bool(sharing.get('public_share_enabled'))
        sharing_text = '<b class="ok">enabled</b>' if sharing_enabled else '<b class="bad">disabled</b>'
        if sharing_error: sharing_text = '<b class="bad">unavailable</b> <code>' + html.escape(sharing_error) + '</code>'
        update_text = '' if not update else (f"<p>Available version: <b>{html.escape(update['available'])}</b></p>" + (f'<form method="post" action="/install-update"><input type="hidden" name="csrf" value="{self.csrf}"><button>Install update</button></form>' if update['update_available'] else '<p class="ok">You are up to date.</p>'))
        page = f'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Stream GPS Device</title><style>body{{font:16px system-ui;background:#0b1120;color:#e5edf7;max-width:760px;margin:30px auto;padding:16px}}section{{background:#121b2b;border:1px solid #28364b;border-radius:12px;padding:20px;margin:16px 0}}input{{width:100%;box-sizing:border-box;padding:10px;margin:5px 0 14px;background:#0f1726;color:white;border:1px solid #44536a;border-radius:7px}}button{{padding:10px 15px;background:#1f6feb;color:white;border:0;border-radius:7px;margin-right:8px}}.danger{{background:#b42318}}.ok{{color:#35d39a}}.bad{{color:#f97066}}code{{overflow-wrap:anywhere}}</style></head><body><h1>Stream GPS Device</h1><section><h2>Status</h2><p>Modem: <b>{html.escape(str(status['modem'] or 'not detected'))}</b></p><p>GPS fix: <b class="{'ok' if status['gps_fix'] else 'bad'}">{'yes' if status['gps_fix'] else 'no'}</b></p><p>Queued points: <b>{status['queue_size']}</b></p><p>Last error: <code>{html.escape(str(status['last_error'] or 'none'))}</code></p></section><section><h2>Viewer privacy</h2><p>Public location sharing: {sharing_text}</p>{'' if sharing_error else f'<form method="post" action="/toggle-public-sharing"><input type="hidden" name="csrf" value="{self.csrf}"><input type="hidden" name="enabled" value="{str(not sharing_enabled).lower()}"><button class="{"danger" if sharing_enabled else ""}">{"Stop sharing" if sharing_enabled else "Start sharing"}</button></form>'}<p>Only the current viewer map is affected. GPS uploads and the private dashboard continue working.</p></section><section><h2>Configuration</h2><form method="post" action="/save"><input type="hidden" name="csrf" value="{self.csrf}"><label>Platform URL</label><input name="api_url" value="{html.escape(config['api_url'])}" required><label>Device ID</label><input name="device_id" value="{html.escape(config['device_id'])}" required><label>New device key (leave empty to keep current)</label><input name="device_key" type="password"><label>Update interval in seconds (0.5–10)</label><input name="interval_seconds" type="number" min="0.5" max="10" step="0.5" value="{float(config.get('interval_seconds',2)):g}"><label>Modem ID (`auto` recommended)</label><input name="modem_id" value="{html.escape(str(config.get('modem_id','auto')))}"><button>Save configuration</button></form></section><section><h2>System</h2><p>Agent version: <b>{html.escape(installed)}</b></p><form method="post" action="/check-update"><input type="hidden" name="csrf" value="{self.csrf}"><button>Check for updates</button></form>{update_text}</section></body></html>'''
        self.respond(200, page)
    def do_POST(self):
        if not self.require_auth(): return
        from urllib.parse import parse_qs
        length = min(int(self.headers.get('Content-Length', '0')), 20000); form = parse_qs(self.rfile.read(length).decode())
        if form.get('csrf', [''])[0] != self.csrf: self.respond(403, 'Invalid form token'); return
        if self.path == '/test-connection':
            try:
                config = load_config(); validate_connection(form.get('api_url', [''])[0], form.get('device_id', [''])[0], form.get('device_key', [''])[0], config)
                self.respond(200, json.dumps({'message': 'Connected to Stream GPS. You can now save this configuration.'}), 'application/json')
            except PermissionError as error: self.respond(401, json.dumps({'message': str(error)}), 'application/json')
            except Exception as error: self.respond(502, json.dumps({'message': 'Connection failed: ' + str(error)}), 'application/json')
            return
        if self.path == '/connect':
            try:
                config = load_config(); candidate = validate_connection(form.get('api_url', [''])[0], form.get('device_id', [''])[0], form.get('device_key', [''])[0], config)
                config.update(candidate); save_config(config); self.redirect_home()
            except Exception as error:
                self.respond(400, self.setup_page('Connection was not saved: ' + str(error)))
            return
        if self.path == '/toggle-public-sharing':
            try:
                enabled = form.get('enabled', ['false'])[0] == 'true'
                device_api(load_config(), 'PATCH', {'enabled': enabled})
                self.redirect_home()
            except Exception as error: self.respond(502, 'Unable to update public sharing: ' + html.escape(str(error)))
            return
        if self.path == '/check-update':
            try:
                with LOCK: STATUS['update_check'] = check_update()
                self.redirect_home()
            except Exception as error: self.respond(502, 'Update check failed: ' + html.escape(str(error)))
            return
        if self.path == '/install-update':
            try:
                release = check_update()
                if not release['update_available']: self.respond(409, 'No update is available'); return
                unit = 'stream-gps-device-update-' + str(int(time.time()))
                result = run('systemd-run', '--unit=' + unit, '--collect', '/usr/bin/python3', str(Path(__file__).resolve()), 'apply-update')
                if result.returncode: raise RuntimeError(result.stderr.strip() or 'Unable to schedule updater')
                self.respond(202, '''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="20;url=/"><title>Updating Stream GPS Device</title><style>body{font:16px system-ui;background:#0b1120;color:#e5edf7;max-width:680px;margin:60px auto;padding:20px}a{color:#79b8ff}</style></head><body><h1>Update started</h1><p>The agent is restarting. Returning to the main page in <b id="countdown">20</b> seconds.</p><p><a href="/">Return now</a></p><script>let remaining=20;const timer=setInterval(()=>{remaining-=1;document.getElementById('countdown').textContent=remaining;if(remaining<=0){clearInterval(timer);location.replace('/')}},1000)</script></body></html>''')
            except Exception as error: self.respond(500, 'Unable to start update: ' + html.escape(str(error)))
            return
        if self.path != '/save': self.respond(404, 'Not found'); return
        config = load_config(); interval = float(form.get('interval_seconds', ['2'])[0]); api_url = form.get('api_url', [''])[0].strip().rstrip('/')
        if not 0.5 <= interval <= 10: self.respond(400, 'Interval must be between 0.5 and 10 seconds'); return
        if not api_url.startswith(('http://', 'https://')): self.respond(400, 'Platform URL must begin with http:// or https://'); return
        config.update(api_url=api_url, device_id=form.get('device_id', [''])[0].strip(), interval_seconds=interval, modem_id=form.get('modem_id', ['auto'])[0].strip() or 'auto')
        if form.get('device_key', [''])[0].strip(): config['device_key'] = form['device_key'][0].strip()
        save_config(config); self.redirect_home()
    def log_message(self, fmt, *args): print('web:', fmt % args)

def diagnostic():
    config = load_config(); modem = find_modem(config)
    checks = [('Configuration', configured(config)), ('ModemManager', run('mmcli', '-L').returncode == 0), ('Modem detected', modem is not None)]
    position = None
    if modem is not None:
        enable_gps(modem)
        try: position = read_position(modem)
        except Exception: pass
    checks.append(('GPS fix', position is not None))
    api_ok = False
    if position and configured(config):
        try: upload(config, position); api_ok = True
        except Exception as error: print('[FAIL] API upload:', error)
    checks.append(('Authenticated API upload', api_ok))
    for name, passed in checks: print(('[OK]   ' if passed else '[FAIL] ') + name)
    return 0 if all(value for _, value in checks) else 1

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('command', nargs='?', default='run', choices=['run','status','test','config','apply-update'])
    args = parser.parse_args()
    if args.command == 'status':
        print(json.dumps(STATUS, indent=2)); return
    if args.command == 'test': raise SystemExit(diagnostic())
    if args.command == 'config':
        config = load_config(); config['device_key'] = '***hidden***'; print(json.dumps(config, indent=2)); return
    if args.command == 'apply-update': apply_update(); return
    threading.Thread(target=tracking_loop, daemon=True).start()
    config = load_config(); ThreadingHTTPServer((config.get('ui_bind', '0.0.0.0'), int(config.get('ui_port', 26666))), Handler).serve_forever()

if __name__ == '__main__': main()
