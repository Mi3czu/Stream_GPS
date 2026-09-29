#!/usr/bin/env python3
"""Standalone Stream GPS agent. It does not import or modify BelaUI."""

import argparse, asyncio, base64, hashlib, hmac, html, json, math, os, re, secrets, shutil, statistics, subprocess, tempfile, threading, time, urllib.error, urllib.request, uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CONFIG_PATH = Path('/etc/stream-gps-device/config.json')
QUEUE_PATH = Path('/var/lib/stream-gps-device/queue.jsonl')
STATE_DIR = QUEUE_PATH.parent
UPDATE_STATUS_PATH = STATE_DIR / 'update-status.json'
XTRA_PATH = STATE_DIR / 'xtra-assistance.bin'
XTRA_STATUS_PATH = STATE_DIR / 'xtra-status.json'
XTRA_REFRESH_SECONDS = 72 * 60 * 60
XTRA_RETRY_SECONDS = 30
UPDATE_SUCCESS_NOTICE_SECONDS = 10 * 60
STATUS = {'started_at': time.time(), 'modem': None, 'modem_info': {}, 'gps_fix': False, 'last_position': None, 'last_upload': None, 'last_error': None, 'queue_size': 0,
          'gnss': {'assisted_mode': 'Not checked', 'assistance': 'Not checked', 'source_rate_hz': None, 'last_fresh_fix': None},
          'ble': {'available': None, 'state': 'Not configured', 'heart_rate': None, 'cadence': None, 'power_watts': None, 'last_reading': None, 'devices': []}}
LOCK = threading.Lock()
DEFAULT_UPDATE_BASE = 'https://raw.githubusercontent.com/Mi3czu/Stream_GPS/main/device-agent'
GITHUB_HEAD_API = 'https://api.github.com/repos/Mi3czu/Stream_GPS/commits/main'
UPDATE_FILES = ('stream_gps_agent.py', 'stream-gps-device', 'stream-gps-device.service', 'install-bluetooth-support.sh', 'VERSION')
CPU_SAMPLE = None
GNSS_RATE_SAMPLES = []
INCLINE_SAMPLES = []
INCLINE_DISTANCE_METERS = 0.0
INCLINE_LAST_POINT = None
INCLINE_LAST_SAMPLE_DISTANCE = 0.0
POSITION_FILTER = {'mode': 'moving', 'anchor': None, 'slow_samples': 0, 'exit_speed_samples': 0, 'exit_distance_samples': 0, 'moving_samples': []}
POSITION_FILTER_DEFAULTS = {'stationary_hold_enabled': True, 'stationary_enter_speed_kmh': 1.0, 'stationary_exit_speed_kmh': 2.0, 'stationary_enter_samples': 5, 'stationary_exit_samples': 3, 'stationary_exit_distance_m': 15.0, 'stationary_exit_max_hdop': 1.5, 'stationary_exit_min_satellites': 4, 'moving_median_samples': 3, 'moving_median_max_speed_kmh': 20.0}
INCLINE_SETTINGS_DEFAULTS = {'incline_min_speed_kmh': 1.4}
TRIP_MOVEMENT_SETTINGS_DEFAULTS = {'trip_min_speed_kmh': 1.4}
BLE_HEART_RATE_UUID = '00002a37-0000-1000-8000-00805f9b34fb'
BLE_HEART_RATE_SERVICE_UUID = '0000180d-0000-1000-8000-00805f9b34fb'
BLE_CSC_SERVICE_UUID = '00001816-0000-1000-8000-00805f9b34fb'
BLE_CSC_MEASUREMENT_UUID = '00002a5b-0000-1000-8000-00805f9b34fb'
BLE_POWER_SERVICE_UUID = '00001818-0000-1000-8000-00805f9b34fb'
BLE_POWER_MEASUREMENT_UUID = '00002a63-0000-1000-8000-00805f9b34fb'
BLE_SCAN_SECONDS = 20
BLE_STACK_RESET_AFTER_FAILURES = 6
BLE_STACK_RESET_COOLDOWN_SECONDS = 120
BLE_SERVICE_TYPES = {
    '0000180d-0000-1000-8000-00805f9b34fb': 'Heart rate',
    '00001816-0000-1000-8000-00805f9b34fb': 'Cycling speed and cadence',
    '00001818-0000-1000-8000-00805f9b34fb': 'Cycling power',
    '00001814-0000-1000-8000-00805f9b34fb': 'Running speed and cadence',
    '00001826-0000-1000-8000-00805f9b34fb': 'Fitness machine',
}

def bleak_import():
    try:
        from bleak import BleakClient, BleakScanner
        return BleakClient, BleakScanner
    except ImportError:
        return None, None

def classify_ble_device(device, advertisement):
    uuids = [str(value).lower() for value in (getattr(advertisement, 'service_uuids', None) or [])]
    name = getattr(device, 'name', None) or getattr(advertisement, 'local_name', None) or 'Unnamed BLE device'
    detected = [label for uuid, label in BLE_SERVICE_TYPES.items() if uuid in uuids]
    if detected: return ', '.join(detected)
    if re.search(r'(h10|h9|h2|heart|hrm)', name, re.I): return 'Possible heart rate'
    return 'Unknown BLE profile'

def scan_ble_devices():
    _, scanner = bleak_import()
    if scanner is None: raise RuntimeError('BLE support is not installed. Run: sudo /usr/bin/python3 -m pip install --break-system-packages bleak')
    async def scan():
        try:
            found = await scanner.discover(timeout=BLE_SCAN_SECONDS, return_adv=True)
            return [{'address': address, 'name': getattr(device, 'name', None) or getattr(advertisement, 'local_name', None) or 'Unnamed BLE device',
                     'rssi': getattr(advertisement, 'rssi', None), 'kind': classify_ble_device(device, advertisement)} for address, (device, advertisement) in found.items()]
        except TypeError:
            return [{'address': device.address, 'name': device.name or 'Unnamed BLE device', 'rssi': getattr(device, 'rssi', None), 'kind': 'BLE device'} for device in await scanner.discover(timeout=BLE_SCAN_SECONDS)]
    devices = sorted(asyncio.run(scan()), key=lambda item: (item['kind'] == 'Unknown BLE profile', item['name'].lower()))
    with LOCK: STATUS['ble'].update(available=True, devices=devices, state='Scan complete')
    return devices

def heart_rate_from_notification(data):
    values = bytes(data)
    if len(values) < 2: return None
    bpm = int.from_bytes(values[1:3], 'little') if values[0] & 1 else values[1]
    return bpm if 1 <= bpm <= 300 else None

def power_from_notification(data):
    values = bytes(data)
    if len(values) < 4: return None
    watts = int.from_bytes(values[2:4], 'little', signed=True)
    return watts if 0 <= watts <= 3000 else None

def cadence_decoder():
    previous = [None, None]
    def decode(data):
        values = bytes(data)
        if not values or not values[0] & 2 or len(values) < 5: return None
        offset = 1 + (4 if values[0] & 1 else 0)
        if len(values) < offset + 4: return None
        revolutions = int.from_bytes(values[offset:offset + 2], 'little'); event_time = int.from_bytes(values[offset + 2:offset + 4], 'little')
        if previous[0] is None: previous[:] = [revolutions, event_time]; return None
        delta_revolutions = (revolutions - previous[0]) & 0xffff; delta_time = (event_time - previous[1]) & 0xffff
        previous[:] = [revolutions, event_time]
        return round(delta_revolutions * 60 * 1024 / delta_time, 1) if delta_time and delta_revolutions else 0
    return decode

def verify_heart_rate_sensor(address):
    return verify_ble_service(address, BLE_HEART_RATE_SERVICE_UUID, 'Heart Rate')

def verify_ble_service(address, service_uuid, label):
    client_class, _ = bleak_import()
    if client_class is None: raise RuntimeError('BLE support is not installed. Run: sudo /usr/bin/python3 -m pip install --break-system-packages bleak')
    async def verify():
        async with client_class(address, timeout=15) as client:
            services = client.services
            if services is None:
                services = await client.get_services()
            return any(str(service.uuid).lower() == service_uuid for service in services)
    if not asyncio.run(verify()): raise ValueError(f'This device does not expose the standard Bluetooth {label} service.')

def reset_bluetooth_stack(address):
    """Recover BlueZ after a sensor leaves radio range during a GATT session."""
    try: subprocess.run(['bluetoothctl', 'disconnect', address], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
    except (OSError, subprocess.TimeoutExpired): pass
    result = subprocess.run(['systemctl', 'restart', 'bluetooth.service'], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, timeout=20)
    if result.returncode: raise RuntimeError((result.stderr or 'Unable to restart bluetooth.service').strip())

def ble_heart_rate_loop():
    failed_attempts = 0
    last_stack_reset = 0
    while True:
        config = load_config(); address = str(config.get('ble_heart_rate_address') or '').upper()
        if not config.get('bluetooth_enabled', False):
            with LOCK: STATUS['ble'].update(available=None, state='Bluetooth sensors disabled', heart_rate=None, cadence=None, power_watts=None)
            time.sleep(10); continue
        client_class, _ = bleak_import()
        if client_class is None:
            with LOCK: STATUS['ble'].update(available=False, state='BLE support missing')
            time.sleep(15); continue
        if not re.fullmatch(r'(?:[0-9A-F]{2}:){5}[0-9A-F]{2}', address):
            with LOCK: STATUS['ble'].update(available=True, state='No heart-rate sensor selected', heart_rate=None)
            time.sleep(3); continue
        try:
            if failed_attempts == 0 or failed_attempts % 3 == 0:
                with LOCK: STATUS['ble'].update(state='Scanning before connection')
                scan_ble_devices()
            async def collect():
                def received(_, data):
                    bpm = heart_rate_from_notification(data)
                    if bpm is not None:
                        with LOCK: STATUS['ble'].update(state='Connected', heart_rate=bpm, last_reading=time.time(), available=True)
                async with client_class(address, timeout=15) as client:
                    await client.start_notify(BLE_HEART_RATE_UUID, received)
                    with LOCK: STATUS['ble'].update(state='Connected', available=True)
                    nonlocal failed_attempts; failed_attempts = 0
                    while load_config().get('bluetooth_enabled', False) and str(load_config().get('ble_heart_rate_address') or '').upper() == address: await asyncio.sleep(1)
            asyncio.run(collect())
        except Exception as error:
            failed_attempts += 1
            if failed_attempts >= BLE_STACK_RESET_AFTER_FAILURES and time.time() - last_stack_reset >= BLE_STACK_RESET_COOLDOWN_SECONDS:
                try:
                    with LOCK: STATUS['ble'].update(available=True, state='Resetting Bluetooth after repeated reconnect failures')
                    reset_bluetooth_stack(address); last_stack_reset = time.time(); failed_attempts = 0
                except Exception as reset_error:
                    with LOCK: STATUS['ble'].update(available=True, state='Bluetooth reset failed: ' + str(reset_error)[:100])
            with LOCK: STATUS['ble'].update(available=True, state='Reconnecting: ' + str(error)[:100])
            time.sleep(5)

def ble_metric_loop(config_key, status_key, characteristic_uuid, decoder, label):
    while True:
        config = load_config(); address = str(config.get(config_key) or '').upper(); client_class, _ = bleak_import()
        if not config.get('bluetooth_enabled', False): time.sleep(10); continue
        if client_class is None or not re.fullmatch(r'(?:[0-9A-F]{2}:){5}[0-9A-F]{2}', address): time.sleep(5); continue
        try:
            async def collect():
                def received(_, data):
                    value = decoder(data)
                    if value is not None:
                        with LOCK: STATUS['ble'].update(**{status_key: value, 'last_reading': time.time(), 'available': True})
                async with client_class(address, timeout=15) as client:
                    await client.start_notify(characteristic_uuid, received)
                    while load_config().get('bluetooth_enabled', False) and str(load_config().get(config_key) or '').upper() == address: await asyncio.sleep(1)
            asyncio.run(collect())
        except Exception:
            with LOCK: STATUS['ble'].update(**{status_key: None})
            time.sleep(5)

def load_config():
    with CONFIG_PATH.open(encoding='utf-8') as handle: return json.load(handle)

def save_config(config):
    temporary = CONFIG_PATH.with_suffix('.tmp')
    temporary.write_text(json.dumps(config, indent=2) + '\n', encoding='utf-8')
    os.chmod(temporary, 0o600); temporary.replace(CONFIG_PATH)

def position_filter_config(config):
    settings = dict(POSITION_FILTER_DEFAULTS)
    for name, default in POSITION_FILTER_DEFAULTS.items():
        value = config.get(name, default)
        try: settings[name] = bool(value) if isinstance(default, bool) else type(default)(value)
        except (TypeError, ValueError): settings[name] = default
    return settings

def incline_settings(config):
    try: value = float(config.get('incline_min_speed_kmh', INCLINE_SETTINGS_DEFAULTS['incline_min_speed_kmh']))
    except (TypeError, ValueError): value = INCLINE_SETTINGS_DEFAULTS['incline_min_speed_kmh']
    return {'incline_min_speed_kmh': min(10, max(0, value))}

def trip_movement_settings(config):
    try: value = float(config.get('trip_min_speed_kmh', TRIP_MOVEMENT_SETTINGS_DEFAULTS['trip_min_speed_kmh']))
    except (TypeError, ValueError): value = TRIP_MOVEMENT_SETTINGS_DEFAULTS['trip_min_speed_kmh']
    return {'trip_min_speed_kmh': min(10, max(0, value))}

def position_filter_settings_from_form(form):
    settings = {
        'stationary_hold_enabled': form.get('stationary_hold_enabled', [''])[0] == 'on',
        'stationary_enter_speed_kmh': float(form.get('stationary_enter_speed_kmh', ['1'])[0]),
        'stationary_exit_speed_kmh': float(form.get('stationary_exit_speed_kmh', ['2'])[0]),
        'stationary_enter_samples': int(form.get('stationary_enter_samples', ['5'])[0]),
        'stationary_exit_samples': int(form.get('stationary_exit_samples', ['3'])[0]),
        'stationary_exit_distance_m': float(form.get('stationary_exit_distance_m', ['15'])[0]),
        'stationary_exit_max_hdop': float(form.get('stationary_exit_max_hdop', ['1.5'])[0]),
        'stationary_exit_min_satellites': int(form.get('stationary_exit_min_satellites', ['4'])[0]),
        'moving_median_samples': int(form.get('moving_median_samples', ['3'])[0]),
        'moving_median_max_speed_kmh': float(form.get('moving_median_max_speed_kmh', ['20'])[0]),
    }
    if not (0 <= settings['stationary_enter_speed_kmh'] <= 10 and 0.1 <= settings['stationary_exit_speed_kmh'] <= 30 and 1 <= settings['stationary_enter_samples'] <= 20 and 1 <= settings['stationary_exit_samples'] <= 20 and 2 <= settings['stationary_exit_distance_m'] <= 100 and 0.5 <= settings['stationary_exit_max_hdop'] <= 10 and 0 <= settings['stationary_exit_min_satellites'] <= 20 and settings['moving_median_samples'] in (1, 3, 5) and 0 <= settings['moving_median_max_speed_kmh'] <= 100):
        raise ValueError('Advanced position-filter values are outside their allowed range.')
    return settings

def save_update_status(state, **details):
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        temporary = UPDATE_STATUS_PATH.with_suffix('.tmp')
        temporary.write_text(json.dumps({'state': state, 'updated_at': time.time(), **details}), encoding='utf-8')
        os.chmod(temporary, 0o600); temporary.replace(UPDATE_STATUS_PATH)
    except OSError:
        pass

def load_update_status():
    try:
        with UPDATE_STATUS_PATH.open(encoding='utf-8') as handle:
            status = json.load(handle)
        if not isinstance(status, dict): return {}
        if status.get('state') == 'succeeded' and time.time() - float(status.get('updated_at', 0)) > UPDATE_SUCCESS_NOTICE_SECONDS:
            UPDATE_STATUS_PATH.unlink(missing_ok=True)
            return {}
        return status
    except (OSError, ValueError):
        return {}

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

def release_base(config=None):
    base = update_base(config)
    # A branch URL is mutable and can be served from independent CDN caches.
    # Resolve it once to a commit URL, so VERSION, manifest and files always
    # come from the same immutable repository snapshot.
    github_release = re.fullmatch(r'https://raw\.githubusercontent\.com/Mi3czu/Stream_GPS/(?:main|[0-9a-f]{40})/device-agent', base)
    if not github_release:
        return base
    payload = json.loads(download(GITHUB_HEAD_API).decode('utf-8'))
    commit = str(payload.get('sha', ''))
    if not re.fullmatch(r'[0-9a-f]{40}', commit): raise RuntimeError('GitHub did not return a valid release commit')
    return f'https://raw.githubusercontent.com/Mi3czu/Stream_GPS/{commit}/device-agent'

def download(url, timeout=20):
    request = urllib.request.Request(url, headers={'User-Agent': 'Stream-GPS-Device-Updater/1.0'})
    with urllib.request.urlopen(request, timeout=timeout) as response: return response.read()

def remote_size(url, timeout=20):
    request = urllib.request.Request(url, headers={'User-Agent': 'Stream-GPS-Device-Updater/1.0'}, method='HEAD')
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            length = response.headers.get('Content-Length')
            return int(length) if length and int(length) >= 0 else None
    except (OSError, ValueError, urllib.error.URLError):
        return None

def update_download_size(base):
    # The install action re-checks VERSION, then fetches the manifest and all
    # release files. HEAD requests below obtain their sizes without downloading
    # their contents.
    names = ('VERSION', 'checksums.sha256', *UPDATE_FILES)
    sizes = [remote_size(base + '/' + name) for name in names]
    return sum(sizes) if all(size is not None for size in sizes) else None

def check_update(config=None, include_download_size=True):
    base = release_base(config)
    available = download(base + '/VERSION').decode('utf-8').strip()
    version_tuple(available)
    installed = current_version()
    update_available = version_tuple(available) > version_tuple(installed)
    return {'installed': installed, 'available': available, 'update_available': update_available,
            'download_bytes': update_download_size(base) if update_available and include_download_size else None,
            'release_base': base}

def apply_update():
    save_update_status('downloading')
    try:
        version = _apply_update()
    except Exception as error:
        save_update_status('failed', error=str(error))
        raise
    save_update_status('succeeded', version=version or current_version())

def _apply_update():
    config = load_config(); release = check_update(config, include_download_size=False); base = release['release_base']
    if not release['update_available']:
        print('No update available'); return
    names = UPDATE_FILES
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
            for name in ('stream_gps_agent.py', 'stream-gps-device', 'install-bluetooth-support.sh', 'VERSION'):
                shutil.copy2(staging / name, install_dir / name)
            os.chmod(install_dir / 'stream_gps_agent.py', 0o755); os.chmod(install_dir / 'stream-gps-device', 0o755); os.chmod(install_dir / 'install-bluetooth-support.sh', 0o755)
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
            return release['available']
        except Exception:
            for name in ('stream_gps_agent.py', 'stream-gps-device', 'install-bluetooth-support.sh', 'VERSION'):
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

def read_xtra_status():
    try:
        payload = json.loads(XTRA_STATUS_PATH.read_text(encoding='utf-8'))
        return payload if isinstance(payload, dict) else {}
    except (OSError, ValueError):
        return {}

def write_xtra_status(**details):
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        temporary = XTRA_STATUS_PATH.with_suffix('.tmp')
        temporary.write_text(json.dumps(details), encoding='utf-8')
        os.chmod(temporary, 0o600); temporary.replace(XTRA_STATUS_PATH)
    except OSError:
        pass

def location_capabilities(modem):
    result = run('mmcli', '-m', modem, '--location-status')
    if result.returncode: return set(), []
    text = result.stdout.lower()
    capabilities = set(re.findall(r'\b(?:agps-msa|agps-msb|xtra)\b', text))
    servers = re.findall(r'https://[^\s|]+', result.stdout)
    return capabilities, servers

def inject_xtra_assistance(modem, servers):
    status = read_xtra_status()
    fresh_cache = XTRA_PATH.exists() and time.time() - float(status.get('downloaded_at', 0)) < XTRA_REFRESH_SECONDS
    if not fresh_cache:
        downloaded = None
        for server in servers:
            try:
                data = download(server, timeout=8)
                if not 1024 <= len(data) <= 2 * 1024 * 1024: continue
                downloaded = data; break
            except (OSError, urllib.error.URLError, urllib.error.HTTPError):
                continue
        if downloaded is None:
            return 'XTRA unavailable (using regular GNSS)'
        try:
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            temporary = XTRA_PATH.with_suffix('.tmp')
            temporary.write_bytes(downloaded); os.chmod(temporary, 0o600); temporary.replace(XTRA_PATH)
            write_xtra_status(downloaded_at=time.time(), bytes=len(downloaded))
        except OSError:
            return 'XTRA cache could not be saved'
    result = run('mmcli', '-m', modem, '--location-inject-assistance-data=' + str(XTRA_PATH))
    return 'XTRA injected' if result.returncode == 0 else 'XTRA rejected by modem (using regular GNSS)'

def enable_gps(modem):
    capabilities, servers = location_capabilities(modem)
    assisted_mode = 'Not supported'
    if {'agps-msb', 'agps-msa'} & capabilities:
        # A-GPS must be selected before GPS RAW/NMEA starts. ModemManager can
        # preserve the old sources across an agent restart, so restart them.
        run('mmcli', '-m', modem, '--location-disable-gps-raw')
        run('mmcli', '-m', modem, '--location-disable-gps-nmea')
    for mode in ('agps-msb', 'agps-msa'):
        if mode in capabilities and run('mmcli', '-m', modem, '--location-enable-' + mode).returncode == 0:
            assisted_mode = mode.upper(); break
    assistance = inject_xtra_assistance(modem, servers) if 'xtra' in capabilities and servers else 'XTRA not supported'
    run('mmcli', '-m', modem, '--location-enable-gps-raw')
    run('mmcli', '-m', modem, '--location-enable-gps-nmea')
    with LOCK:
        STATUS['gnss'].update(assisted_mode=assisted_mode, assistance=assistance)

def retry_xtra_assistance(modem):
    capabilities, servers = location_capabilities(modem)
    if 'xtra' not in capabilities or not servers: return
    assistance = inject_xtra_assistance(modem, servers)
    with LOCK:
        STATUS['gnss']['assistance'] = assistance

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
                if fields[1]: nmea.setdefault('source_time', fields[1])
                if fields[7]: nmea['speed'] = float(fields[7]) * 1.852
                if fields[8]: nmea['heading'] = float(fields[8]) % 360
            elif kind == 'GGA' and len(fields) >= 10 and fields[6] not in ('', '0'):
                nmea.setdefault('latitude', nmea_coordinate(fields[2], fields[3])); nmea.setdefault('longitude', nmea_coordinate(fields[4], fields[5]))
                if fields[1]: nmea['source_time'] = fields[1]
                if fields[7]: nmea['satellites'] = int(fields[7])
                # ModemManager does not expose a metre accuracy value on every
                # modem. GGA includes HDOP, from which a conservative GPS
                # accuracy estimate can be derived using a 5 m UERE.
                if fields[8]:
                    nmea['hdop'] = float(fields[8]); nmea['accuracy'] = round(nmea['hdop'] * 5, 1)
                if fields[9]: nmea['altitude'] = float(fields[9])
        except (ValueError, IndexError): pass
    latitude = number('modem.location.gps.latitude')
    longitude = number('modem.location.gps.longitude')
    latitude = latitude if latitude is not None else nmea.get('latitude'); longitude = longitude if longitude is not None else nmea.get('longitude')
    if latitude is None or longitude is None: return None
    position = {'latitude': latitude, 'longitude': longitude, 'recorded_at': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')}
    if nmea.get('source_time'): position['_gnss_time'] = nmea['source_time']
    if nmea.get('speed') is not None: position['_sog'] = nmea['speed']
    if nmea.get('hdop') is not None: position['_hdop'] = nmea['hdop']
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

def nmea_seconds(value):
    match = re.fullmatch(r'(\d{2})(\d{2})(\d{2}(?:\.\d+)?)', str(value or ''))
    if not match: return None
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)

def update_gnss_metrics(position):
    global GNSS_RATE_SAMPLES
    source_time = position.get('_gnss_time')
    if not source_time: return
    now = time.time(); source_seconds = nmea_seconds(source_time)
    with LOCK:
        gnss = STATUS['gnss']
        previous_time = gnss.get('source_time')
        previous_seconds = nmea_seconds(previous_time)
        if source_time != previous_time:
            if source_seconds is not None and previous_seconds is not None:
                interval = source_seconds - previous_seconds
                if interval <= 0: interval += 24 * 60 * 60
                if 0.05 <= interval <= 30:
                    GNSS_RATE_SAMPLES = (GNSS_RATE_SAMPLES + [interval])[-8:]
                    gnss['source_rate_hz'] = round(len(GNSS_RATE_SAMPLES) / sum(GNSS_RATE_SAMPLES), 1)
            gnss.update(source_time=source_time, last_fresh_fix=now)

def reset_position_filter():
    global POSITION_FILTER
    POSITION_FILTER = {'mode': 'moving', 'anchor': None, 'slow_samples': 0, 'exit_speed_samples': 0, 'exit_distance_samples': 0, 'moving_samples': []}

def apply_position_filter(position, config):
    """Hold a stable anchor at rest; use SOG from RMC before coordinate deltas."""
    settings = position_filter_config(config)
    if not settings['stationary_hold_enabled']:
        reset_position_filter(); return position
    global POSITION_FILTER
    speed = position.get('_sog', position.get('speed', 0))
    try: speed = float(speed or 0)
    except (TypeError, ValueError): speed = 0
    hdop = position.get('_hdop'); satellites = position.get('satellites')
    quality_good = ((hdop is None or float(hdop) <= settings['stationary_exit_max_hdop']) and (satellites is None or int(satellites) >= settings['stationary_exit_min_satellites']))
    state = POSITION_FILTER
    if state['mode'] == 'moving':
        state['slow_samples'] = state['slow_samples'] + 1 if speed < settings['stationary_enter_speed_kmh'] else 0
        if state['slow_samples'] >= settings['stationary_enter_samples']:
            state.update(mode='stationary', anchor=dict(position), exit_speed_samples=0, exit_distance_samples=0, moving_samples=[])
        else:
            samples = state['moving_samples']
            if speed <= settings['moving_median_max_speed_kmh'] and settings['moving_median_samples'] > 1:
                samples.append((position['latitude'], position['longitude'])); del samples[:-settings['moving_median_samples']]
                if len(samples) >= settings['moving_median_samples']:
                    position = dict(position); position['latitude'] = statistics.median(item[0] for item in samples); position['longitude'] = statistics.median(item[1] for item in samples)
            else: state['moving_samples'] = []
            return position
    anchor = state['anchor']; distance = horizontal_distance_meters((anchor['latitude'], anchor['longitude']), (position['latitude'], position['longitude']))
    state['exit_speed_samples'] = state['exit_speed_samples'] + 1 if quality_good and speed >= settings['stationary_exit_speed_kmh'] else 0
    state['exit_distance_samples'] = state['exit_distance_samples'] + 1 if quality_good and distance >= settings['stationary_exit_distance_m'] else 0
    if state['exit_speed_samples'] >= settings['stationary_exit_samples'] or state['exit_distance_samples'] >= settings['stationary_exit_samples']:
        reset_position_filter(); return position
    held = dict(position); held['latitude'] = anchor['latitude']; held['longitude'] = anchor['longitude']; held['speed'] = 0; held['_stationary_hold'] = True
    with LOCK: STATUS['position_filter'] = {'mode': 'stationary', 'sog_kmh': round(speed, 2), 'hdop': hdop, 'satellites': satellites, 'anchor_distance_m': round(distance, 1), 'quality_good': quality_good}
    return held

def horizontal_distance_meters(first, second):
    latitude_a, longitude_a = map(math.radians, first)
    latitude_b, longitude_b = map(math.radians, second)
    delta_latitude = latitude_b - latitude_a; delta_longitude = longitude_b - longitude_a
    value = math.sin(delta_latitude / 2) ** 2 + math.cos(latitude_a) * math.cos(latitude_b) * math.sin(delta_longitude / 2) ** 2
    return 6_371_000 * 2 * math.atan2(math.sqrt(value), math.sqrt(1 - value))

def incline_window_meters(speed):
    if speed < 7: return 50
    if speed < 25: return 80
    return 120

def update_estimated_incline(position, config):
    """Attach a conservative grade estimate from a distance-based altitude profile."""
    global INCLINE_SAMPLES, INCLINE_DISTANCE_METERS, INCLINE_LAST_POINT, INCLINE_LAST_SAMPLE_DISTANCE
    position['incline'] = None
    try:
        point = (float(position['latitude']), float(position['longitude']))
        altitude = float(position['altitude']); speed = float(position.get('speed') or 0)
    except (KeyError, TypeError, ValueError): return
    if not all(math.isfinite(value) for value in (*point, altitude, speed)) or speed < incline_settings(config)['incline_min_speed_kmh']:
        INCLINE_SAMPLES = []; INCLINE_DISTANCE_METERS = 0.0; INCLINE_LAST_POINT = None; INCLINE_LAST_SAMPLE_DISTANCE = 0.0
        return
    if INCLINE_LAST_POINT is None:
        INCLINE_LAST_POINT = point; INCLINE_SAMPLES = [(0.0, altitude)]; return
    segment = horizontal_distance_meters(INCLINE_LAST_POINT, point); INCLINE_LAST_POINT = point
    if segment < 1 or segment > 80: return
    INCLINE_DISTANCE_METERS += segment
    if INCLINE_DISTANCE_METERS - INCLINE_LAST_SAMPLE_DISTANCE < 8: return
    INCLINE_LAST_SAMPLE_DISTANCE = INCLINE_DISTANCE_METERS
    recent_altitudes = [sample[1] for sample in INCLINE_SAMPLES[-8:]]
    if recent_altitudes and abs(altitude - statistics.median(recent_altitudes)) > 15: return
    INCLINE_SAMPLES.append((INCLINE_DISTANCE_METERS, altitude))
    window = incline_window_meters(speed); cutoff = INCLINE_DISTANCE_METERS - window
    INCLINE_SAMPLES = [sample for sample in INCLINE_SAMPLES if sample[0] >= cutoff]
    bins = {}
    for distance, sample_altitude in INCLINE_SAMPLES:
        bins.setdefault(int(distance // 16), []).append((distance, sample_altitude))
    profile = [(statistics.median(item[0] for item in values), statistics.median(item[1] for item in values)) for values in bins.values()]
    profile.sort()
    if len(profile) < 4 or profile[-1][0] - profile[0][0] < min(40, window * 0.7): return
    mean_distance = statistics.mean(item[0] for item in profile); mean_altitude = statistics.mean(item[1] for item in profile)
    divisor = sum((distance - mean_distance) ** 2 for distance, _ in profile)
    if divisor <= 0: return
    grade = 100 * sum((distance - mean_distance) * (sample_altitude - mean_altitude) for distance, sample_altitude in profile) / divisor
    if abs(grade) <= 25: position['incline'] = round(grade, 1)

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

class PositionOutOfOrderError(Exception): pass

def upload(config, position):
    body = json.dumps({key: value for key, value in position.items() if not key.startswith('_')}).encode()
    request = urllib.request.Request(config['api_url'].rstrip('/') + '/api/v1/gps/update', data=body, method='POST', headers={
        'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config['device_key'],
        'X-Device-Id': config['device_id'], 'X-Request-Timestamp': str(int(time.time())),
        'X-Request-Nonce': str(uuid.uuid4()), 'User-Agent': 'Stream-GPS-Device/1.0'
    })
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            if response.status not in (200, 201): raise RuntimeError('API returned HTTP ' + str(response.status))
    except urllib.error.HTTPError as error:
        response_body = error.read().decode('utf-8', 'replace')
        if error.code == 409 and 'GPS_POSITION_OUT_OF_ORDER' in response_body:
            raise PositionOutOfOrderError('Position is older than the last accepted update') from error
        raise

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

def modem_info(modem):
    result = run('mmcli', '-K', '-m', modem)
    if result.returncode: return {}
    values = {}
    for line in result.stdout.splitlines():
        if ':' not in line: continue
        key, value = line.split(':', 1); values[key.strip()] = value.strip().strip("'")
    def first_value(*keys):
        for key in keys:
            if values.get(key): return values[key]
        return ''
    def indexed_values(prefix):
        return [values[key] for key in sorted(values) if key.startswith(prefix) and values[key] and values[key] != '--']
    signal = first_value('modem.generic.signal-quality.value', 'modem.generic.signal-quality', 'modem.signal-quality')
    signal_match = re.search(r'\d+', signal)
    technologies = indexed_values('modem.generic.access-technologies.value[')
    if not technologies:
        raw_technology = first_value('modem.generic.access-technologies', 'modem.3gpp.access-technologies')
        technologies = [raw_technology] if raw_technology and raw_technology != '--' else []
    ports = indexed_values('modem.generic.ports.value[')
    network_port = next((re.split(r'\s+', port, 1)[0] for port in ports if '(net)' in port), '')
    return {
        'signal_quality': int(signal_match.group()) if signal_match else None,
        'access_technology': ', '.join(technologies),
        'registration': first_value('modem.3gpp.registration-state', 'modem.generic.state'),
        'operator': first_value('modem.3gpp.operator-name', 'modem.3gpp.operator-code'),
        'manufacturer': first_value('modem.generic.manufacturer'),
        'model': first_value('modem.generic.model'),
        'revision': first_value('modem.generic.revision'),
        'network_port': network_port,
    }

def display_technology(value):
    labels = []
    for item in re.split(r'[,/\s]+', str(value or '').lower()):
        if not item: continue
        if item in ('5g', 'nr5g', 'nr'): label = '5G'
        elif item == 'lte': label = '4G (LTE)'
        elif item in ('umts', 'hsdpa', 'hsupa', 'hspa', 'hspa-plus', 'wcdma'): label = '3G'
        elif item in ('gsm', 'gprs', 'edge'): label = '2G'
        else: label = item.upper()
        if label not in labels: labels.append(label)
    return ' / '.join(labels) or 'Technology unavailable'

def system_metrics():
    global CPU_SAMPLE
    metrics = {'cpu': None, 'memory_used': None, 'memory_total': None, 'disk_used': None, 'disk_total': None, 'temperature': None}
    try:
        fields = Path('/proc/stat').read_text(encoding='utf-8').splitlines()[0].split()[1:]
        values = [int(value) for value in fields]; total = sum(values); idle = values[3] + (values[4] if len(values) > 4 else 0)
        if CPU_SAMPLE:
            previous_total, previous_idle = CPU_SAMPLE; delta_total, delta_idle = total - previous_total, idle - previous_idle
            if delta_total > 0: metrics['cpu'] = round(100 * (1 - delta_idle / delta_total))
        CPU_SAMPLE = (total, idle)
    except (OSError, ValueError, IndexError): pass
    try:
        memory = {}
        for line in Path('/proc/meminfo').read_text(encoding='utf-8').splitlines():
            key, value = line.split(':', 1); memory[key] = int(value.split()[0]) * 1024
        metrics['memory_total'] = memory.get('MemTotal'); metrics['memory_used'] = memory.get('MemTotal', 0) - memory.get('MemAvailable', 0)
    except (OSError, ValueError, IndexError): pass
    try:
        disk = shutil.disk_usage(STATE_DIR); metrics['disk_used'] = disk.used; metrics['disk_total'] = disk.total
    except OSError: pass
    temperatures = []
    for path in Path('/sys/class/thermal').glob('thermal_zone*/temp'):
        try:
            value = float(path.read_text(encoding='utf-8').strip()); temperatures.append(value / 1000 if value > 1000 else value)
        except (OSError, ValueError): pass
    if temperatures: metrics['temperature'] = round(max(temperatures), 1)
    return metrics

def format_bytes(value):
    if value is None: return 'Not available'
    for unit in ('B', 'KB', 'MB', 'GB', 'TB'):
        if value < 1024 or unit == 'TB': return f'{value:.0f} {unit}' if unit == 'B' else f'{value:.1f} {unit}'
        value /= 1024

def elapsed(value):
    if not value: return 'Never'
    seconds = max(0, int(time.time() - value))
    if seconds < 60: return f'{seconds}s ago'
    if seconds < 3600: return f'{seconds // 60}m ago'
    return f'{seconds // 3600}h ago'

def tracking_loop():
    gps_enabled_for = None
    last_modem_poll = 0
    last_xtra_retry = 0
    xtra_retry_delay = XTRA_RETRY_SECONDS
    last_heart_rate_heartbeat = 0
    while True:
        try:
            config = load_config()
            if not configured(config):
                with LOCK: STATUS['last_error'] = 'Not connected to Stream GPS. Complete setup in the local panel.'
                time.sleep(2); continue
            modem = find_modem(config)
            if modem is None: raise RuntimeError('No ModemManager modem detected')
            if modem != gps_enabled_for:
                enable_gps(modem); gps_enabled_for = modem; last_xtra_retry = time.time(); xtra_retry_delay = XTRA_RETRY_SECONDS
            with LOCK: STATUS['modem'] = modem
            with LOCK: assistance = STATUS['gnss'].get('assistance')
            if assistance != 'XTRA injected' and time.time() - last_xtra_retry >= xtra_retry_delay:
                retry_xtra_assistance(modem); last_xtra_retry = time.time()
                with LOCK: assistance = STATUS['gnss'].get('assistance')
                if assistance != 'XTRA injected': xtra_retry_delay = min(xtra_retry_delay * 2, 10 * 60)
            if time.time() - last_modem_poll >= 30:
                info = modem_info(modem)
                with LOCK: STATUS['modem_info'] = info
                last_modem_poll = time.time()
            position = read_position(modem)
            if position is None:
                with LOCK:
                    heart_rate = STATUS['ble'].get('heart_rate'); cadence = STATUS['ble'].get('cadence'); power_watts = STATUS['ble'].get('power_watts'); last_position = STATUS.get('last_position')
                if any(value is not None for value in (heart_rate, cadence, power_watts)) and last_position and time.time() - last_heart_rate_heartbeat >= 15:
                    heartbeat = {'latitude': last_position['latitude'], 'longitude': last_position['longitude'], 'speed': 0,
                                 'heart_rate': heart_rate, 'recorded_at': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')}
                    if cadence is not None: heartbeat['cadence'] = cadence
                    if power_watts is not None: heartbeat['power_watts'] = power_watts
                    try:
                        upload(config, heartbeat); last_heart_rate_heartbeat = time.time()
                        with LOCK: STATUS['last_upload'] = time.time(); STATUS['last_error'] = 'Waiting for GPS fix; heart-rate telemetry is uploading'
                    except Exception as heartbeat_error:
                        with LOCK: STATUS['last_error'] = 'Waiting for GPS fix; heart-rate upload failed: ' + str(heartbeat_error)
                else:
                    with LOCK: STATUS['last_error'] = 'Waiting for GPS fix'
                with LOCK: STATUS['gps_fix'] = False
                time.sleep(max(2, int(config.get('interval_seconds', 2)))); continue
            position = apply_position_filter(position, config)
            position['trip_min_speed_kmh'] = trip_movement_settings(config)['trip_min_speed_kmh']
            with LOCK: heart_rate = STATUS['ble'].get('heart_rate'); cadence = STATUS['ble'].get('cadence'); power_watts = STATUS['ble'].get('power_watts')
            if heart_rate is not None: position['heart_rate'] = heart_rate
            if cadence is not None: position['cadence'] = cadence
            if power_watts is not None: position['power_watts'] = power_watts
            update_gnss_metrics(position)
            update_estimated_incline(position, config)
            with LOCK: STATUS['gps_fix'] = True; STATUS['last_position'] = position; STATUS['last_error'] = None
            pending = queue_items(); pending.append(dict(position, _queued_at=time.time()))
            remaining = []
            for index, item in enumerate(pending):
                try: upload(config, item)
                except PositionOutOfOrderError:
                    # A prior release only used whole-second timestamps. Drop
                    # those stale duplicates so they cannot block new uploads.
                    continue
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
    def error_page(self, message):
        return f'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Stream GPS Device</title><style>body{{align-items:center;background:#0b1120;color:#e5edf7;display:flex;font:16px system-ui;justify-content:center;margin:0;min-height:100vh;padding:20px}}.dialog{{background:#121b2b;border:1px solid #4b2028;border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.45);max-width:460px;padding:24px;width:100%}}h1{{font-size:1.2rem;margin:0 0 10px}}p{{color:#c9d5e5;line-height:1.5}}button{{background:#1f6feb;border:0;border-radius:7px;color:white;cursor:pointer;font:inherit;font-weight:700;padding:10px 15px}}</style></head><body><div class="dialog" role="alertdialog" aria-modal="true"><h1>Something needs attention</h1><p>{html.escape(str(message))}</p><button type="button" onclick="location.replace('/')">Close</button></div></body></html>'''
    def respond_error(self, status, message):
        self.respond(status, self.error_page(message))
    def setup_page(self, message=''):
        notification = f'<p class="notice">{html.escape(message)}</p>' if message else ''
        return f'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect Stream GPS</title><style>body{{font:16px system-ui;background:#0b1120;color:#e5edf7;max-width:760px;margin:30px auto;padding:16px}}section{{background:#121b2b;border:1px solid #28364b;border-radius:12px;padding:20px;margin:16px 0}}input{{width:100%;box-sizing:border-box;padding:10px;margin:5px 0 14px;background:#0f1726;color:white;border:1px solid #44536a;border-radius:7px}}button{{padding:10px 15px;background:#1f6feb;color:white;border:0;border-radius:7px;margin-right:8px;cursor:pointer}}button:disabled{{opacity:.55;cursor:not-allowed}}.secondary{{background:#28364b}}.ok{{color:#35d39a}}.error{{background:#4b2028;border-radius:8px;color:#ffb4ab;padding:10px 12px}}.notice{{background:#17365c;border-radius:8px;color:#cbe3ff;padding:10px 12px}}.key-row{{display:flex;gap:8px}}.key-row input{{margin-bottom:14px}}.key-row button{{height:42px;margin-top:5px;white-space:nowrap}}.hint{{color:#aab9cc;font-size:.9em}}</style></head><body><h1>Connect Stream GPS</h1><section><h2>Finish device setup</h2><p>Enter the credentials from your Stream GPS <b>Devices</b> page. The agent saves them only after the platform accepts them.</p>{notification}<form id="connect-form" method="post" action="/connect"><input type="hidden" name="csrf" value="{self.csrf}"><label>Platform URL</label><input name="api_url" placeholder="https://stream-gps.example" inputmode="url" required><label>Device ID</label><input name="device_id" placeholder="BELABOX_7522" required><label>Device key</label><div class="key-row"><input id="device-key" name="device_key" type="password" autocomplete="off" required><button class="secondary" id="toggle-key" type="button">Show</button></div><p id="trim-notice" class="notice" hidden>Leading or trailing spaces were removed before testing.</p><button id="test-button" class="secondary" type="button">Test connection</button><button id="connect-button" type="submit" disabled>Save and connect</button><p id="result" aria-live="polite"></p></form></section><section><h2>What happens next</h2><p>After a successful connection, the agent starts GPS uploads. You can then change the upload interval and modem settings here.</p><p class="hint">The device key remains hidden after saving. To retrieve it later, use <b>Your keys</b> on the device page in Stream GPS.</p></section><script>const form=document.getElementById('connect-form'),key=document.getElementById('device-key'),notice=document.getElementById('trim-notice'),result=document.getElementById('result'),save=document.getElementById('connect-button');function clean(){{let changed=false;for(const input of form.querySelectorAll('input[name="api_url"],input[name="device_id"],input[name="device_key"]')){{const value=input.value.trim();if(value!==input.value){{input.value=value;changed=true}}}}notice.hidden=!changed}}document.getElementById('toggle-key').onclick=()=>{{key.type=key.type==='password'?'text':'password';document.getElementById('toggle-key').textContent=key.type==='password'?'Show':'Hide'}};document.getElementById('test-button').onclick=async()=>{{clean();result.className='notice';result.textContent='Testing connection…';save.disabled=true;try{{const response=await fetch('/test-connection',{{method:'POST',body:new FormData(form)}});const payload=await response.json();result.className=response.ok?'ok':'error';result.textContent=payload.message;save.disabled=!response.ok}}catch(error){{result.className='error';result.textContent='Unable to test the connection.'}}}};form.addEventListener('submit',clean);</script></body></html>'''
    def dashboard_page(self, config, status, sharing, sharing_error, update):
        info = status.get('modem_info') or {}
        metrics = system_metrics()
        signal = info.get('signal_quality')
        signal_text = f'{signal}%' if signal is not None else 'Not available'
        satellites = (status.get('last_position') or {}).get('satellites')
        satellites_text = str(satellites) if satellites is not None else 'Not available'
        incline = (status.get('last_position') or {}).get('incline')
        incline_text = f'{float(incline):+.1f}%' if incline is not None else 'Measuring'
        gnss = status.get('gnss') or {}
        source_rate = gnss.get('source_rate_hz')
        source_rate_text = f'{source_rate:g} Hz' if source_rate is not None else 'Measuring'
        fresh_fix = gnss.get('last_fresh_fix')
        source_hint = f'last new NMEA fix {elapsed(fresh_fix)}' if fresh_fix else 'waiting for a new NMEA fix'
        assisted_hint = f'{gnss.get("assisted_mode", "Not checked")} · {gnss.get("assistance", "Not checked")}'
        connected = bool(status.get('last_upload') and time.time() - status['last_upload'] < 90)
        upload_text, upload_class = ('Connected', 'good') if connected else ('Waiting for upload', 'warn')
        gps_text, gps_class = ('GPS fix active', 'good') if status.get('gps_fix') else ('Waiting for GPS fix', 'warn')
        modem_name = info.get('operator') or f'Modem {status.get("modem") or "not detected"}'
        technology = display_technology(info.get('access_technology'))
        registration = info.get('registration') or 'Registration unavailable'
        modem_model = ' '.join(part for part in (info.get('manufacturer'), info.get('model')) if part) or 'Model unavailable'
        modem_details = ' · '.join(part for part in (info.get('network_port'), modem_model, info.get('revision')) if part)
        sharing_enabled = bool(sharing.get('public_share_enabled'))
        sharing_text = '<b class="good">enabled</b>' if sharing_enabled else '<b class="warn">disabled</b>'
        if sharing_error: sharing_text = '<b class="bad">unavailable</b> <code>' + html.escape(sharing_error) + '</code>'
        sharing_form = '' if sharing_error else f'<form method="post" action="/toggle-public-sharing"><input type="hidden" name="csrf" value="{self.csrf}"><input type="hidden" name="enabled" value="{str(not sharing_enabled).lower()}"><button class="{"secondary" if sharing_enabled else ""}">{"Stop sharing" if sharing_enabled else "Start sharing"}</button></form>'
        if not update:
            update_text = ''
        elif update['update_available']:
            download_size = format_bytes(update.get('download_bytes'))
            update_text = (f"<p>Available version: <b>{html.escape(update['available'])}</b>"
                           f"<br><small>Download: <b>{html.escape(download_size)}</b> (agent files and verification manifest)</small></p>"
                           f'<form method="post" action="/install-update"><input type="hidden" name="csrf" value="{self.csrf}"><button>Install update</button></form>')
        else:
            update_text = '<p class="good">You are up to date.</p>'
        update_status = load_update_status()
        update_pending = update_status.get('state') in ('scheduled', 'downloading')
        if update_pending:
            update_text += '<p class="warn"><b>Update in progress.</b> Refreshing status automatically every 5 seconds. Slow mobile connections can take up to 5 minutes.</p>'
        elif update_status.get('state') == 'succeeded':
            version = html.escape(str(update_status.get('version') or ''))
            update_text += f'<p class="good"><b>Last update completed successfully.</b>{" Installed version: " + version + "." if version else ""}</p>'
        elif update_status.get('state') == 'failed':
            update_text += '<p class="status-error"><b>Last update failed:</b> ' + html.escape(str(update_status.get('error') or 'Unknown error')) + '</p>'
        auto_refresh = '<script>window.setTimeout(()=>location.reload(),5000)</script>' if update_pending else ''
        def metric(label, value, hint): return f'<div class="metric"><span>{html.escape(label)}</span><b>{html.escape(value)}</b><small>{html.escape(hint)}</small></div>'
        system_cards = ''.join((
            metric('CPU', f'{metrics["cpu"]}%' if metrics['cpu'] is not None else 'Measuring…', 'current usage'),
            metric('Memory', f'{format_bytes(metrics["memory_used"])} / {format_bytes(metrics["memory_total"])}', 'used / total'),
            metric('Storage', f'{format_bytes(metrics["disk_used"])} / {format_bytes(metrics["disk_total"])}', 'device filesystem'),
            metric('Temperature', f'{metrics["temperature"]} °C' if metrics['temperature'] is not None else 'Not available', 'hardware sensor'),
        ))
        error = status.get('last_error')
        error_html = f'<p class="status-error"><b>Attention:</b> {html.escape(str(error))}</p>' if error and error != 'Waiting for GPS fix' else ''
        error_html = (f'<p><b>GNSS diagnostics:</b> {html.escape(source_rate_text)} · {html.escape(source_hint)}'
                      f'<br><small>A-GPS: {html.escape(assisted_hint)}</small></p>') + error_html
        filter_settings = position_filter_config(config)
        incline_config = incline_settings(config)
        trip_config = trip_movement_settings(config)
        filter_status = status.get('position_filter') or {'mode': 'moving'}
        advanced_filter_form = f'''<details><summary><h2>Advanced position filter</h2><small>Mode: {html.escape(str(filter_status.get('mode', 'moving')))}</small></summary><div><p>Applied before upload. It holds one anchored coordinate while the GNSS reports that the device is stationary.</p><p><small>Live diagnostics: SOG {html.escape(str(filter_status.get('sog_kmh', '—')))} km/h · HDOP {html.escape(str(filter_status.get('hdop', '—')))} · satellites {html.escape(str(filter_status.get('satellites', '—')))} · anchor distance {html.escape(str(filter_status.get('anchor_distance_m', '—')))} m</small></p><form method="post" action="/save-position-filter"><input type="hidden" name="csrf" value="{self.csrf}"><label><input type="checkbox" name="stationary_hold_enabled" {'checked' if filter_settings['stationary_hold_enabled'] else ''}> Enable stationary hold</label><label>Enter stationary below SOG (km/h)</label><input name="stationary_enter_speed_kmh" type="number" min="0" max="10" step="0.1" value="{filter_settings['stationary_enter_speed_kmh']:g}"><label>Consecutive low-speed fixes to hold</label><input name="stationary_enter_samples" type="number" min="1" max="20" value="{filter_settings['stationary_enter_samples']}"><label>Resume above SOG (km/h)</label><input name="stationary_exit_speed_kmh" type="number" min="0.1" max="30" step="0.1" value="{filter_settings['stationary_exit_speed_kmh']:g}"><label>Consecutive good fixes to resume</label><input name="stationary_exit_samples" type="number" min="1" max="20" value="{filter_settings['stationary_exit_samples']}"><label>Resume distance from anchor (m)</label><input name="stationary_exit_distance_m" type="number" min="2" max="100" step="1" value="{filter_settings['stationary_exit_distance_m']:g}"><label>Maximum HDOP to resume</label><input name="stationary_exit_max_hdop" type="number" min="0.5" max="10" step="0.1" value="{filter_settings['stationary_exit_max_hdop']:g}"><label>Minimum satellites to resume</label><input name="stationary_exit_min_satellites" type="number" min="0" max="20" value="{filter_settings['stationary_exit_min_satellites']}"><label>Moving median samples (1 disables)</label><input name="moving_median_samples" type="number" min="1" max="5" step="2" value="{filter_settings['moving_median_samples']}"><label>Apply median up to SOG (km/h)</label><input name="moving_median_max_speed_kmh" type="number" min="0" max="100" step="1" value="{filter_settings['moving_median_max_speed_kmh']:g}"><button>Save advanced filter</button></form></div></details>'''
        advanced_filter_form += '''<p><small><b>Parameter guide:</b> Enter speed and low-speed fixes decide when a stopped device is anchored. Resume speed, good fixes and anchor distance decide how much evidence is needed before movement resumes. HDOP and satellites are required only to resume from the anchor. Median samples smooth isolated coordinate spikes while moving; set it to 1 to disable smoothing.</small></p><script>const stationaryHold=document.querySelector('input[name="stationary_hold_enabled"]');if(stationaryHold){stationaryHold.style.width='auto';stationaryHold.style.margin='0 8px 0 0';stationaryHold.parentElement.style.display='flex';stationaryHold.parentElement.style.alignItems='center';stationaryHold.parentElement.style.gap='4px'}</script>'''
        error_html += advanced_filter_form
        error_html += f'''<details><summary><h2>Trip movement and active speed</h2><small>Start above: {trip_config['trip_min_speed_kmh']:g} km/h</small></summary><div><p>This threshold starts trip distance and active-session average speed. Below it, GNSS drift and stationary time do not add distance or lower the average used by ETA.</p><form method="post" action="/save-trip-movement-settings"><input type="hidden" name="csrf" value="{self.csrf}"><label>Minimum speed for trip distance, active average and ETA (km/h)</label><small>Use a higher value to reject slow drift. Use a lower value for walking or very slow cycling.</small><input name="trip_min_speed_kmh" type="number" min="0" max="10" step="0.1" value="{trip_config['trip_min_speed_kmh']:g}"><button>Save trip movement settings</button></form></div></details>'''
        error_html += f'''<details><summary><h2>Incline estimate (beta)</h2><small>Minimum movement: {incline_config['incline_min_speed_kmh']:g} km/h</small></summary><div><p>Altitude-derived incline is paused below the minimum speed, so stationary GNSS drift cannot produce a false grade.</p><form method="post" action="/save-incline-settings"><input type="hidden" name="csrf" value="{self.csrf}"><label>Minimum speed for incline (km/h)</label><small>Below this speed, the incline estimator resets. Higher values reject more low-speed altitude noise but delay walking measurements.</small><input name="incline_min_speed_kmh" type="number" min="0" max="10" step="0.1" value="{incline_config['incline_min_speed_kmh']:g}"><button>Save incline settings</button></form></div></details>'''
        error_html += '''<style>.stream-gps-motion-settings form>small{display:block;margin:-4px 0 12px}.stream-gps-motion-settings form>label{display:block;margin-top:12px}</style><script>document.addEventListener('DOMContentLoaded',()=>{const all=[...document.querySelectorAll('details')],configuration=all.find((node)=>node.querySelector('summary h2')?.textContent.trim()==='Configuration'),motion=all.filter((node)=>['Advanced position filter','Trip movement and active speed','Incline estimate (beta)'].includes(node.querySelector('summary h2')?.textContent.trim()));if(configuration&&motion.length){const target=configuration.querySelector(':scope>div');motion.forEach((node)=>{node.classList.add('stream-gps-motion-settings');target.append(node)});const guide=[...document.querySelectorAll('p')].find((node)=>node.textContent.includes('Parameter guide:'));if(guide)target.append(guide)}})</script>'''
        error_html += '''<style>.advanced-filter-help{color:#aab9cc;display:block;font-size:.8rem;line-height:1.4;margin:-2px 0 12px}</style><script>document.addEventListener('DOMContentLoaded',()=>{const help={'Enter stationary below SOG (km/h)':'SOG is GNSS-reported speed. Below this value, a fix counts toward anchoring a stationary device.','Consecutive low-speed fixes to hold':'How many low-speed fixes in a row are needed before the position is frozen. Higher values are more cautious.','Resume above SOG (km/h)':'GNSS-reported speed required as evidence that movement has resumed.','Consecutive good fixes to resume':'How many consecutive fixes meeting the movement-quality rules are required to unfreeze the position.','Resume distance from anchor (m)':'Alternative movement evidence: sustained distance from the frozen coordinate. Higher values reject more drift.','Maximum HDOP to resume':'Maximum allowed horizontal dilution of precision when resuming. Lower values demand a more reliable GNSS fix.','Minimum satellites to resume':'Minimum satellites required when resuming movement. Higher values reject weaker fixes.','Moving median samples (1 disables)':'Median window used while moving to remove isolated coordinate spikes. Use 1 to turn smoothing off.','Apply median up to SOG (km/h)':'Median smoothing is used only up to this GNSS speed; fast travel remains responsive.'};document.querySelectorAll('label').forEach((label)=>{const text=label.textContent.trim(),description=help[text];if(description&&!label.nextElementSibling?.classList.contains('advanced-filter-help')){const node=document.createElement('small');node.className='advanced-filter-help';node.textContent=description;label.after(node)}})})</script>'''
        ble = status.get('ble') or {}; selected_sensor = str(config.get('ble_heart_rate_address') or '')
        install_notice = html.escape(str(config.get('bluetooth_install_status') or ''))
        if not config.get('bluetooth_enabled', False):
            sensor_content = f'''<p>Bluetooth sensor support is optional and disabled. GPS works normally without it; no Bluetooth diagnostics or scans run until you enable it.</p>{f'<p class="good"><b>{install_notice}</b></p>' if install_notice else ''}<form method="post" action="/install-bluetooth-support"><input type="hidden" name="csrf" value="{self.csrf}"><button class="secondary">Install Bluetooth support</button></form><p><small>Installs BlueZ, rfkill, Python pip and Bleak. Hardware-specific drivers are not changed automatically.</small></p><form method="post" action="/enable-bluetooth"><input type="hidden" name="csrf" value="{self.csrf}"><button>Enable Bluetooth sensors</button></form>'''
        elif ble.get('available') is False:
            sensor_content = '<p class="status-error">BLE support is missing. Install it once with <code>sudo /usr/bin/python3 -m pip install --break-system-packages bleak</code>, then restart Stream GPS Device.</p>'
        else:
            discovered_devices = ble.get('devices', [])
            options = ''.join(f'<option value="{html.escape(item["address"])}" {"selected" if item["address"].upper() == selected_sensor.upper() else ""}>{html.escape(item["name"])} ({html.escape(item["kind"])}) &mdash; {html.escape(item["address"])}</option>' for item in discovered_devices)
            if selected_sensor and not any(item['address'].upper() == selected_sensor.upper() for item in discovered_devices):
                options = f'<option value="{html.escape(selected_sensor)}" selected>Saved sensor &mdash; {html.escape(selected_sensor)} (temporarily not discovered)</option>' + options
            device_rows = ''
            reading = f'{ble.get("heart_rate")} bpm' if ble.get('heart_rate') is not None else 'waiting for reading'
            sensor_content = f'''<style>.sensor-status{{display:grid;gap:10px;grid-template-columns:repeat(2,minmax(0,1fr));margin-bottom:16px}}.sensor-status div,.sensor-block{{background:#0f1726;border:1px solid #28364b;border-radius:10px;padding:12px}}.sensor-status span,.sensor-block small{{color:#aab9cc;display:block;font-size:.8rem}}.sensor-status b{{display:block;margin-top:4px}}.sensor-block{{margin-top:10px}}.sensor-heading,.sensor-form{{align-items:center;display:flex;gap:12px;justify-content:space-between}}.sensor-heading form{{margin:0}}.sensor-list{{list-style:none;margin:12px 0 0;padding:0}}.sensor-list li{{border-top:1px solid #28364b;padding:9px 0}}.sensor-list li:first-child{{border-top:0;padding-top:0}}.sensor-list span{{color:#aab9cc;display:block;font-size:.8rem;margin-top:3px}}.sensor-list .empty{{color:#aab9cc}}.sensor-form{{margin:12px 0 8px}}.sensor-form select{{background:#0b1120;border:1px solid #44536a;border-radius:8px;color:#e5edf7;min-width:0;padding:10px;width:100%}}@media(max-width:650px){{.sensor-status{{grid-template-columns:1fr}}.sensor-heading,.sensor-form{{align-items:stretch;flex-direction:column}}.sensor-heading button,.sensor-form button{{width:100%}}}}</style><div class="sensor-status"><div><span>Connection</span><b>{html.escape(str(ble.get('state') or 'Not configured'))}</b></div><div><span>Heart rate</span><b>{html.escape(reading)}</b></div></div><div class="sensor-block"><div class="sensor-heading"><div><b>Discovered Bluetooth devices</b><small>All nearby BLE devices are listed. Profile names come from the advertised service when available.</small></div><form method="post" action="/scan-ble"><input type="hidden" name="csrf" value="{self.csrf}"><button class="secondary">Scan again</button></form></div><ul class="sensor-list">{device_rows}</ul></div><div class="sensor-block"><b>Active heart-rate sensor</b><small>One heart-rate sensor can be active at a time. Cadence and power connections will be added as separate slots.</small><form class="sensor-form" method="post" action="/save-heart-rate-sensor"><input type="hidden" name="csrf" value="{self.csrf}"><select name="ble_heart_rate_address"><option value="">Not selected</option>{options}</select><button>Save heart-rate sensor</button></form><small>The selected device is verified as a standard Heart Rate sensor before the agent connects.</small></div>'''
        sensor_content = sensor_content.replace('One heart-rate sensor can be active at a time. Cadence and power connections will be added as separate slots.', 'Select one sensor for each metric. Heart rate, cadence and power can run simultaneously.')
        if config.get('bluetooth_enabled', False) and ble.get('available') is not False:
            selected_cadence = str(config.get('ble_cadence_address') or ''); selected_power = str(config.get('ble_power_address') or '')
            def metric_options(selected):
                return ''.join(f'<option value="{html.escape(item["address"])}" {"selected" if item["address"].upper() == selected.upper() else ""}>{html.escape(item["name"])} ({html.escape(item["kind"])})</option>' for item in (ble.get('devices') or []))
            sensor_content += f'''<div class="sensor-block"><b>Cadence sensor</b><form class="sensor-form" method="post" action="/save-ble-sensor"><input type="hidden" name="csrf" value="{self.csrf}"><input type="hidden" name="sensor_type" value="cadence"><select name="address"><option value="">Not selected</option>{metric_options(selected_cadence)}</select><button>Save cadence sensor</button></form></div><div class="sensor-block"><b>Power sensor</b><form class="sensor-form" method="post" action="/save-ble-sensor"><input type="hidden" name="csrf" value="{self.csrf}"><input type="hidden" name="sensor_type" value="power"><select name="address"><option value="">Not selected</option>{metric_options(selected_power)}</select><button>Save power sensor</button></form></div><script>document.querySelector('.sensor-block:last-of-type')?.previousElementSibling?.previousElementSibling?.querySelector('small')?.replaceChildren('Select one sensor for each metric. Heart rate, cadence and power can run simultaneously.');</script>'''
        if config.get('bluetooth_enabled', False):
            sensor_content += f'''<form method="post" action="/disable-bluetooth"><input type="hidden" name="csrf" value="{self.csrf}"><button class="secondary">Disable Bluetooth sensors</button></form><small>Stops sensor connections, scanning and automatic reconnects. Installed Bluetooth packages and hardware configuration are kept.</small>'''
        sensor_content = '<style>.sensor-list{display:none}.sensor-form select{flex:1 1 0;width:auto}.sensor-form button{flex:0 0 156px;min-height:48px}</style>' + sensor_content
        error_html += f'''<details><summary><h2>Bluetooth sensors (beta)</h2><small>{html.escape(str(ble.get('state') or 'Not configured'))}</small></summary><div>{sensor_content}</div></details>'''
        return f'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Stream GPS Device</title><style>body{{background:#0b1120;color:#e5edf7;font:16px system-ui;margin:0;padding:24px}}main{{margin:auto;max-width:860px}}section,details{{background:#121b2b;border:1px solid #28364b;border-radius:14px;margin:14px 0;padding:18px}}h1,h2,p{{margin-top:0}}h1{{font-size:1.55rem;margin-bottom:4px}}h2{{font-size:1.05rem;margin-bottom:8px}}p,small{{color:#aab9cc}}button{{background:#1f6feb;border:0;border-radius:8px;color:white;cursor:pointer;font:inherit;font-weight:700;padding:9px 13px}}button.secondary{{background:#28364b}}input{{background:#0f1726;border:1px solid #44536a;border-radius:8px;box-sizing:border-box;color:white;margin:5px 0 14px;padding:10px;width:100%}}.top{{align-items:center;display:flex;gap:16px;justify-content:space-between}}.top p{{margin:0}}.health{{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));margin-top:16px}}.modem-grid,.system-grid{{display:grid;gap:10px;grid-template-columns:repeat(4,minmax(0,1fr));margin-top:16px}}.health-card,.metric,.modem-grid div{{background:#0f1726;border:1px solid #28364b;border-radius:10px;padding:12px}}.health-card span,.metric span,.modem-grid span{{color:#93a5bd;display:block;font-size:.75rem;font-weight:700;text-transform:uppercase}}.health-card b,.metric b,.modem-grid b{{display:block;font-size:1rem;margin:6px 0 3px;overflow-wrap:anywhere}}.health-card small,.metric small{{font-size:.76rem}}.good{{color:#35d39a}}.warn{{color:#fbbf24}}.bad{{color:#f97066}}.status-error{{background:#3b2028;border:1px solid #71333d;border-radius:9px;color:#ffd1cc;margin:14px 0 0;padding:10px 12px}}details{{padding:0}}summary{{align-items:center;cursor:pointer;display:flex;justify-content:space-between;list-style:none;padding:18px}}summary::-webkit-details-marker{{display:none}}summary small{{margin-left:auto;margin-right:12px}}details>div{{border-top:1px solid #28364b;padding:18px}}.key-row{{display:flex;gap:8px}}.key-row input{{margin-bottom:14px}}.key-row button{{height:42px;margin-top:5px;white-space:nowrap}}code{{overflow-wrap:anywhere}}@media(max-width:650px){{body{{padding:14px}}.top{{align-items:flex-start;flex-direction:column}}.health,.modem-grid,.system-grid{{grid-template-columns:repeat(2,minmax(0,1fr))}}}}</style></head><body><main><header class="top"><div><h1>Stream GPS Device</h1><p>Live health, modem and system status.</p></div><button class="secondary" onclick="location.reload()">Refresh status</button></header><section><h2>Device health</h2><div class="health"><div class="health-card"><span>GPS</span><b class="{gps_class}">{gps_text}</b><small>Modem {html.escape(str(status.get('modem') or 'not detected'))}</small></div><div class="health-card"><span>Upload</span><b class="{upload_class}">{upload_text}</b><small>Last upload {html.escape(elapsed(status.get('last_upload')))}</small></div><div class="health-card"><span>Satellites</span><b class="{'good' if satellites is not None and satellites >= 4 else 'warn'}">{html.escape(satellites_text)}</b><small>GPS satellites in use</small></div><div class="health-card"><span>Incline (beta)</span><b>{html.escape(incline_text)}</b><small>adaptive 50–120 m profile</small></div><div class="health-card"><span>Offline queue</span><b>{status.get('queue_size', 0)}</b><small>stored positions</small></div></div>{error_html}</section><section><div class="top"><div><h2>Modem</h2><p>{html.escape(modem_details)}</p></div></div><div class="modem-grid"><div><span>Network</span><b>{html.escape(modem_name)}</b></div><div><span>Registration</span><b>{html.escape(registration)}</b></div><div><span>Technology</span><b>{html.escape(technology)}</b></div><div><span>Signal quality</span><b class="{'good' if signal is not None and signal >= 50 else 'warn'}">{html.escape(signal_text)}</b></div></div></section><section><h2>Viewer privacy</h2><p>Public location sharing: {sharing_text}</p>{sharing_form}<p>Only the viewer map is affected. GPS uploads and the private dashboard continue working.</p></section><details><summary><h2>Configuration</h2><small>{html.escape(config['api_url'])} · {html.escape(str(config.get('modem_id', 'auto')))} · {float(config.get('interval_seconds', 2)):g}s</small></summary><div><form method="post" action="/save"><input type="hidden" name="csrf" value="{self.csrf}"><label>Platform URL</label><input name="api_url" value="{html.escape(config['api_url'])}" required><label>Device ID</label><input name="device_id" value="{html.escape(config['device_id'])}" required><label>New device key (leave empty to keep current)</label><div class="key-row"><input id="device-key" name="device_key" type="password"><button class="secondary" id="toggle-key" type="button">Show</button></div><label>Update interval in seconds (0.5–10)</label><input name="interval_seconds" type="number" min="0.5" max="10" step="0.5" value="{float(config.get('interval_seconds',2)):g}"><label>Modem ID (`auto` recommended)</label><input name="modem_id" value="{html.escape(str(config.get('modem_id','auto')))}"><button>Save configuration</button></form></div></details><section><div class="top"><div><h2>System</h2><p>Agent version <b>{html.escape(current_version())}</b> · running for {html.escape(elapsed(status.get('started_at')))}</p></div><form method="post" action="/check-update"><input type="hidden" name="csrf" value="{self.csrf}"><button class="secondary">Check for updates</button></form></div><div class="system-grid">{system_cards}</div>{update_text}</section><script>const toggle=document.getElementById('toggle-key');if(toggle)toggle.onclick=()=>{{const key=document.getElementById('device-key');key.type=key.type==='password'?'text':'password';toggle.textContent=key.type==='password'?'Show':'Hide'}}</script>{auto_refresh}</main></body></html>'''
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
        self.respond(200, self.dashboard_page(config, status, sharing, sharing_error, update)); return
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
        if form.get('csrf', [''])[0] != self.csrf: self.respond_error(403, 'Your form has expired. Close this message and try again.'); return
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
                self.respond_error(400, 'Connection was not saved: ' + str(error))
            return
        if self.path == '/toggle-public-sharing':
            try:
                enabled = form.get('enabled', ['false'])[0] == 'true'
                device_api(load_config(), 'PATCH', {'enabled': enabled})
                self.redirect_home()
            except Exception as error: self.respond_error(502, 'Unable to update public sharing: ' + str(error))
            return
        if self.path == '/save-position-filter':
            try:
                config = load_config(); config.update(position_filter_settings_from_form(form)); save_config(config); reset_position_filter(); self.redirect_home()
            except Exception as error: self.respond_error(400, 'Unable to save advanced position filter: ' + str(error))
            return
        if self.path == '/save-incline-settings':
            try:
                minimum_speed = float(form.get('incline_min_speed_kmh', ['1.4'])[0])
                if not 0 <= minimum_speed <= 10: raise ValueError('Minimum speed must be between 0 and 10 km/h.')
                config = load_config(); config['incline_min_speed_kmh'] = minimum_speed; save_config(config); self.redirect_home()
            except Exception as error: self.respond_error(400, 'Unable to save incline settings: ' + str(error))
            return
        if self.path == '/save-trip-movement-settings':
            try:
                minimum_speed = float(form.get('trip_min_speed_kmh', ['1.4'])[0])
                if not 0 <= minimum_speed <= 10: raise ValueError('Minimum speed must be between 0 and 10 km/h.')
                config = load_config(); config['trip_min_speed_kmh'] = minimum_speed; save_config(config); self.redirect_home()
            except Exception as error: self.respond_error(400, 'Unable to save trip movement settings: ' + str(error))
            return
        if self.path == '/enable-bluetooth':
            config = load_config(); config['bluetooth_enabled'] = True; save_config(config)
            with LOCK: STATUS['ble'].update(state='Bluetooth sensors enabled')
            self.redirect_home(); return
        if self.path == '/disable-bluetooth':
            config = load_config(); config['bluetooth_enabled'] = False; save_config(config)
            with LOCK: STATUS['ble'].update(available=None, state='Bluetooth sensors disabled', heart_rate=None, cadence=None, power_watts=None)
            self.redirect_home(); return
        if self.path == '/install-bluetooth-support':
            try:
                script = Path(__file__).resolve().parent / 'install-bluetooth-support.sh'
                command = ['/bin/sh', str(script)] if script.exists() else ['/bin/sh', '-c', 'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y bluez python3-pip rfkill && /usr/bin/python3 -m pip install --break-system-packages bleak && systemctl enable --now bluetooth.service']
                unit = 'stream-gps-bluetooth-install'
                result = subprocess.run(['systemd-run', '--unit', unit, '--wait', '--collect', '--quiet', *command], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=600)
                if result.returncode:
                    journal = subprocess.run(['journalctl', '-u', unit, '-n', '30', '--no-pager'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=15).stdout
                    raise RuntimeError((journal or result.stdout or 'Installer failed')[-1200:])
                config = load_config(); config['bluetooth_install_status'] = 'Bluetooth support installed successfully. You can now enable Bluetooth sensors.'; save_config(config)
                self.redirect_home()
            except Exception as error: self.respond_error(502, 'Bluetooth support installation failed: ' + str(error))
            return
        if self.path == '/scan-ble':
            try:
                scan_ble_devices(); self.redirect_home()
            except Exception as error: self.respond_error(502, 'Unable to scan Bluetooth devices: ' + str(error))
            return
        if self.path == '/save-heart-rate-sensor':
            try:
                address = form.get('ble_heart_rate_address', [''])[0].strip().upper()
                if address and not re.fullmatch(r'(?:[0-9A-F]{2}:){5}[0-9A-F]{2}', address): raise ValueError('Invalid Bluetooth address.')
                if address: verify_heart_rate_sensor(address)
                config = load_config(); config['ble_heart_rate_address'] = address; save_config(config)
                with LOCK: STATUS['ble'].update(heart_rate=None, state='Connecting' if address else 'No heart-rate sensor selected')
                self.redirect_home()
            except Exception as error: self.respond_error(400, 'Unable to save heart-rate sensor: ' + str(error))
            return
        if self.path == '/save-ble-sensor':
            try:
                sensor_type = form.get('sensor_type', [''])[0]; address = form.get('address', [''])[0].strip().upper()
                profiles = {'cadence': ('ble_cadence_address', BLE_CSC_SERVICE_UUID, 'Cycling Speed and Cadence'), 'power': ('ble_power_address', BLE_POWER_SERVICE_UUID, 'Cycling Power')}
                if sensor_type not in profiles: raise ValueError('Unknown sensor type.')
                if address and not re.fullmatch(r'(?:[0-9A-F]{2}:){5}[0-9A-F]{2}', address): raise ValueError('Invalid Bluetooth address.')
                key, service, label = profiles[sensor_type]
                if address: verify_ble_service(address, service, label)
                config = load_config(); config[key] = address; save_config(config); self.redirect_home()
            except Exception as error: self.respond_error(400, 'Unable to save Bluetooth sensor: ' + str(error))
            return
        if self.path == '/check-update':
            try:
                with LOCK: STATUS['update_check'] = check_update()
                self.redirect_home()
            except Exception as error: self.respond_error(502, 'Update check failed: ' + str(error))
            return
        if self.path == '/install-update':
            try:
                release = check_update()
                if not release['update_available']: self.respond_error(409, 'No update is available.'); return
                save_update_status('scheduled', version=release['available'])
                unit = 'stream-gps-device-update-' + str(int(time.time()))
                result = run('systemd-run', '--unit=' + unit, '--collect', '--property=TimeoutStartSec=5min', '/usr/bin/python3', str(Path(__file__).resolve()), 'apply-update')
                if result.returncode: raise RuntimeError(result.stderr.strip() or 'Unable to schedule updater')
                self.respond(202, '''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="20;url=/"><title>Updating Stream GPS Device</title><style>body{font:16px system-ui;background:#0b1120;color:#e5edf7;max-width:680px;margin:60px auto;padding:20px}a{color:#79b8ff}</style></head><body><h1>Update in progress</h1><p>The update is downloading and the agent will restart. The dashboard will show whether it completed successfully or failed.</p><p>Returning to the dashboard in <b id="countdown">20</b> seconds. If the connection is slow, it will keep refreshing the progress automatically.</p><p><a href="/">Return now</a></p><script>let remaining=20;const timer=setInterval(()=>{remaining-=1;document.getElementById('countdown').textContent=remaining;if(remaining<=0){clearInterval(timer);location.replace('/')}},1000)</script></body></html>''')
            except Exception as error:
                save_update_status('failed', error=str(error))
                self.respond_error(500, 'Unable to start update: ' + str(error))
            return
        if self.path != '/save': self.respond_error(404, 'This action is not available.'); return
        try: interval = float(form.get('interval_seconds', ['2'])[0])
        except (TypeError, ValueError): self.respond_error(400, 'Update interval must be a number between 0.5 and 10 seconds.'); return
        config = load_config(); api_url = form.get('api_url', [''])[0].strip().rstrip('/')
        if not 0.5 <= interval <= 10: self.respond_error(400, 'Update interval must be between 0.5 and 10 seconds.'); return
        if not api_url.startswith(('http://', 'https://')): self.respond_error(400, 'Platform URL must begin with http:// or https://'); return
        try:
            filter_settings = position_filter_settings_from_form(form) if any(name in form for name in POSITION_FILTER_DEFAULTS) else position_filter_config(config)
            config.update(api_url=api_url, device_id=form.get('device_id', [''])[0].strip(), interval_seconds=interval, modem_id=form.get('modem_id', ['auto'])[0].strip() or 'auto', **filter_settings)
            if form.get('device_key', [''])[0].strip(): config['device_key'] = form['device_key'][0].strip()
            save_config(config); self.redirect_home()
        except Exception as error: self.respond_error(500, 'Unable to save configuration: ' + str(error))
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
    threading.Thread(target=ble_heart_rate_loop, daemon=True).start()
    threading.Thread(target=ble_metric_loop, args=('ble_cadence_address', 'cadence', BLE_CSC_MEASUREMENT_UUID, cadence_decoder(), 'Cadence'), daemon=True).start()
    threading.Thread(target=ble_metric_loop, args=('ble_power_address', 'power_watts', BLE_POWER_MEASUREMENT_UUID, power_from_notification, 'Power'), daemon=True).start()
    config = load_config(); ThreadingHTTPServer((config.get('ui_bind', '0.0.0.0'), int(config.get('ui_port', 26666))), Handler).serve_forever()

if __name__ == '__main__': main()
