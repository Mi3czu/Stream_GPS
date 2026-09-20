import importlib.util, pathlib, tempfile, unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('stream_gps_agent', ROOT / 'device-agent' / 'stream_gps_agent.py')
AGENT = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(AGENT)

class AgentTests(unittest.TestCase):
    def test_parses_raw_mmcli_fields(self):
        result = AGENT.parse_mmcli("""modem.location.gps.latitude : '51.923141'
modem.location.gps.longitude : '15.518596'
modem.location.gps.altitude : '152.8 m'
modem.location.gps.speed : '5.5'
modem.location.gps.heading : '340.8'
modem.location.gps.satellites : '9'""")
        self.assertAlmostEqual(result['latitude'], 51.923141); self.assertEqual(result['satellites'], 9)

    def test_parses_nmea_rmc_and_gga(self):
        text = "modem.location.gps-nmea : '$GNRMC,123519,A,5201.000,N,02100.000,E,10.0,84.4,230394,,,A*00'\nmodem.location.gps-nmea : '$GNGGA,123520,5201.000,N,02100.000,E,1,12,0.8,123.4,M,0,M,,*00'"
        result = AGENT.parse_mmcli(text)
        self.assertAlmostEqual(result['latitude'], 52.01666666, places=5)
        self.assertAlmostEqual(result['speed'], 18.52); self.assertEqual(result['heading'], 84.4)
        self.assertEqual(result['satellites'], 12); self.assertEqual(result['altitude'], 123.4)

    def test_rejects_nmea_without_fix(self):
        self.assertIsNone(AGENT.parse_mmcli("modem.location.gps-nmea : '$GNRMC,123519,V,,,,,,,230394,,,N*00'"))

    def test_queue_is_bounded_and_expires(self):
        original = AGENT.QUEUE_PATH
        try:
            with tempfile.TemporaryDirectory() as directory:
                AGENT.QUEUE_PATH = pathlib.Path(directory) / 'queue.jsonl'
                now = __import__('time').time()
                AGENT.write_queue([{'_queued_at': now, 'latitude': index} for index in range(5100)])
                self.assertEqual(len(AGENT.queue_items()), 5000)
                AGENT.write_queue([{'_queued_at': now - 90000, 'latitude': 1}, {'_queued_at': now, 'latitude': 2}])
                self.assertEqual([item['latitude'] for item in AGENT.queue_items()], [2])
        finally: AGENT.QUEUE_PATH = original

if __name__ == '__main__': unittest.main()
