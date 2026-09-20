#!/usr/bin/env python3
import json, os, time, urllib.error, urllib.request, uuid

BASE = os.environ.get('STREAM_GPS_TEST_BASE', 'http://127.0.0.1:8080')
RUN = uuid.uuid4().hex[:10]

def request(method, path, body=None, token=None, headers=None, expected=200):
    data = json.dumps(body).encode() if body is not None else None
    merged = {'Content-Type': 'application/json', **(headers or {})}
    if token: merged['Authorization'] = 'Bearer ' + token
    try:
        with urllib.request.urlopen(urllib.request.Request(BASE + path, data=data, method=method, headers=merged), timeout=15) as response:
            status, content_type, payload = response.status, response.headers.get('Content-Type', ''), response.read()
    except urllib.error.HTTPError as error:
        status, content_type, payload = error.code, error.headers.get('Content-Type', ''), error.read()
    assert status == expected, f'{method} {path}: expected {expected}, got {status}: {payload.decode(errors="replace")}'
    return json.loads(payload) if 'json' in content_type else payload.decode()

def register_and_login(label):
    username = f'ci_{label}_{RUN}'
    password = f'CI-{RUN}-{label}-secure-password'
    request('POST', '/api/register', {'username': username, 'email': f'{username}@example.test', 'password': password}, expected=201)
    return request('POST', '/api/login', {'username': username, 'password': password})['token']

def main():
    assert request('GET', '/health')['database'] == 'ok'
    owner = register_and_login('owner'); stranger = register_and_login('stranger')
    device_id = f'ci_device_{RUN}'
    created = request('POST', '/api/v1/devices', {'name': 'CI tracker', 'device_id': device_id}, owner, expected=201)
    device_key = created['device_key']
    assert any(item['device_id'] == device_id for item in request('GET', '/api/v1/devices', token=owner)['devices'])
    assert all(item['device_id'] != device_id for item in request('GET', '/api/v1/devices', token=stranger)['devices'])
    request('GET', f'/api/v1/devices/{device_id}', token=stranger, expected=404)

    nonce = str(uuid.uuid4())
    gps_headers = {'Authorization': 'Bearer ' + device_key, 'X-Device-Id': device_id,
                   'X-Request-Timestamp': str(int(time.time())), 'X-Request-Nonce': nonce}
    position = {'latitude': 52.2297, 'longitude': 21.0122, 'altitude': 110.5, 'speed': 18.5,
                'heading': 84.4, 'accuracy': 4.0, 'satellites': 12}
    request('POST', '/api/v1/gps/update', position, headers=gps_headers, expected=201)
    request('POST', '/api/v1/gps/update', position, headers=gps_headers, expected=409)
    history = request('GET', f'/api/v1/devices/{device_id}/history', token=owner)['positions']
    assert len(history) == 1 and float(history[0]['speed']) == 18.5
    csv = request('GET', f'/api/v1/devices/{device_id}/history/export?format=csv', token=owner)
    assert 'latitude,longitude' in csv and '52.2297' in csv
    assert request('POST', f'/api/v1/devices/{device_id}/live-token', token=owner)['expires_in'] == 300
    request('POST', f'/api/v1/devices/{device_id}/live-token', token=stranger, expected=404)
    request('PATCH', f'/api/v1/devices/{device_id}/public-sharing', {'enabled': True}, stranger, expected=404)
    sharing = request('PATCH', f'/api/v1/devices/{device_id}/public-sharing', {'enabled': True}, owner)['sharing']
    share_id = sharing['public_share_id']
    public_device = request('GET', f'/api/v1/public-maps/{share_id}')['device']
    assert public_device['name'] == 'CI tracker' and float(public_device['latitude']) == 52.2297
    request('PATCH', f'/api/v1/devices/{device_id}/public-sharing', {'enabled': False}, owner)
    request('GET', f'/api/v1/public-maps/{share_id}', expected=404)
    request('PATCH', f'/api/v1/devices/{device_id}/public-sharing', {'enabled': True}, owner)
    assert request('GET', f'/api/v1/public-maps/{share_id}')['device']['name'] == 'CI tracker'
    rotated = request('POST', f'/api/v1/devices/{device_id}/public-sharing/rotate', token=owner)['sharing']['public_share_id']
    assert rotated != share_id
    request('GET', f'/api/v1/public-maps/{share_id}', expected=404)
    assert request('GET', f'/api/v1/public-maps/{rotated}')['device']['name'] == 'CI tracker'
    request('PATCH', '/api/me/privacy', {'retention_days': 30}, owner)
    deleted = request('DELETE', f'/api/v1/devices/{device_id}/history', token=owner)
    assert deleted['deleted_points'] == 1
    device = request('GET', f'/api/v1/devices/{device_id}', token=owner)['device']
    assert device['last_latitude'] is None
    print('API integration checks passed')

if __name__ == '__main__': main()
