# Stream GPS Device — samodzielna instalacja na Belaboxie

Ten klient działa jako osobna usługa systemowa. **Nie modyfikuje BelaUI, nie patchuje `belaUI.js` i nie korzysta z interfejsu BelaUI.** Aktualizacja BelaUI nie powinna go usunąć. Własny panel klienta działa domyślnie na porcie `26666`.

## Co będzie potrzebne

- Belabox z dostępem SSH i systemem używającym `systemd`.
- Modem 4G/5G z obsługą GNSS, widoczny w ModemManagerze.
- Antena podłączona do portu GNSS modemu. Port antenowy sieci komórkowej nie zawsze obsługuje GNSS.
- Działający serwer Stream GPS dostępny z Belaboxa przez HTTPS.
- `DEVICE_ID` i jednorazowy `DEVICE_KEY` utworzone na stronie **Devices**.
- Komputer w tej samej zaufanej sieci co Belabox, jeżeli panel `:26666` ma być otwierany bez tunelu SSH.

GPS może uzyskać pozycję bez karty SIM, ale pierwszy fix po zimnym starcie może potrwać kilka lub kilkanaście minut. Najlepiej przeprowadzić test przy oknie lub na zewnątrz.

## 1. Utworzenie urządzenia w platformie

1. Zaloguj się do Stream GPS.
2. Otwórz **Devices**.
3. Wpisz nazwę urządzenia i opcjonalny czytelny identyfikator.
4. Kliknij **Create device**.
5. Zapisz `DEVICE_ID` oraz `DEVICE_KEY`. Klucz jest wyświetlany tylko raz.

Nie zapisuj klucza w GitHubie, wiadomości publicznej ani zrzucie ekranu.

## 2. Sprawdzenie modemu przed instalacją

Połącz się z Belaboxem przez SSH i wykonaj:

```sh
mmcli -L
```

Powinna pojawić się przynajmniej jedna ścieżka zakończona na przykład `/Modem/0`. Następnie:

```sh
sudo mmcli -m 0 --location-enable-gps-raw
sudo mmcli -m 0 --location-enable-gps-nmea
sudo mmcli -K -m 0 --location-get
```

Jeśli numer modemu jest inny niż `0`, użyj numeru pokazanego przez `mmcli -L`. Poprawny fix zawiera `modem.location.gps.latitude` i `modem.location.gps.longitude`.

## 3. Instalacja zalecana — pobranie pliku i sprawdzenie go

Pobierz instalator do pliku:

```sh
curl -fL https://raw.githubusercontent.com/Mi3czu/Stream_GPS/main/installer/install-device.sh -o /tmp/install-stream-gps-device.sh
```

Obejrzyj go przed wykonaniem:

```sh
less /tmp/install-stream-gps-device.sh
```

Uruchom:

```sh
sudo sh /tmp/install-stream-gps-device.sh
```

Instalator zapyta o:

- bazowy adres platformy, np. `https://gps.example.com` — bez `/api/v1/gps/update`;
- `DEVICE_ID`;
- `DEVICE_KEY` (znaki nie będą wyświetlane);
- osobne hasło do lokalnego panelu na porcie `26666`, minimum 12 znaków.

Instalator:

- sprawdzi lub doinstaluje Python 3 i ModemManager;
- zapisze aplikację w `/opt/stream-gps-device`;
- zapisze sekrety w `/etc/stream-gps-device/config.json` z prawami `600`;
- utworzy kolejkę offline w `/var/lib/stream-gps-device`;
- zainstaluje i uruchomi `stream-gps-device.service`;
- nie dotknie katalogu `/opt/belaUI`.

## 4. Otwieranie własnego panelu konfiguracyjnego

Sprawdź adres Belaboxa:

```sh
hostname -I
```

Na komputerze w tej samej sieci otwórz:

```text
http://ADRES_BELABOXA:26666
```

Przeglądarka poprosi o dane Basic Auth:

- użytkownik: `admin`;
- hasło: hasło panelu podane podczas instalacji.

Panel pokazuje modem, stan fixa GPS, rozmiar kolejki i ostatni błąd. Pozwala zmienić adres serwera, `DEVICE_ID`, klucz, numer modemu oraz interwał 2–300 sekund. Istniejący klucz nigdy nie jest wyświetlany.

Port `26666` nie jest typowym portem BelaUI ani standardowych usług systemowych. Sprawdzenie konfliktu:

```sh
sudo ss -ltnp | grep ':26666'
```

Jeżeli przed instalacją widoczny jest inny proces, zmień `ui_port` w `/etc/stream-gps-device/config.json` i zrestartuj usługę.

### Bezpieczny dostęp spoza zaufanej sieci

Panel używa HTTP i nie powinien być wystawiany bezpośrednio do internetu. Zamiast otwierać port na routerze użyj tunelu SSH:

```powershell
ssh -L 26666:127.0.0.1:26666 USER@ADRES_BELABOXA
```

Następnie otwórz `http://127.0.0.1:26666`. Do publicznego dostępu należy później dodać HTTPS/VPN, nie przekierowanie portu.

## 5. Diagnostyka

Status usługi:

```sh
sudo stream-gps-device status
```

Pełny test modemu, fixa, konfiguracji i uwierzytelnionego wysłania punktu:

```sh
sudo stream-gps-device test
```

Ostatnie logi:

```sh
sudo stream-gps-device logs
```

Logi na żywo:

```sh
sudo stream-gps-device follow
```

Bezpieczny podgląd konfiguracji (klucz jest zamaskowany):

```sh
sudo stream-gps-device config
```

Po udanym teście w panelu Stream GPS urządzenie powinno przejść w stan **Online**, a strona urządzenia powinna dostać punkt bez ręcznego odświeżania.

## Kolejka offline

Jeżeli serwer lub internet są niedostępne, klient zapisuje punkty lokalnie. Przechowuje maksymalnie 5000 ostatnich punktów i maksymalnie 24 godziny danych. Po odzyskaniu połączenia wysyła je w kolejności. Zapobiega to zapełnieniu dysku.

## Backup, przywracanie i usuwanie

Backup konfiguracji:

```sh
sudo sh /tmp/install-stream-gps-device.sh --backup
```

Przywrócenie najnowszej kopii:

```sh
sudo sh /tmp/install-stream-gps-device.sh --restore
```

Odinstalowanie programu:

```sh
sudo sh /tmp/install-stream-gps-device.sh --uninstall
```

Odinstalowanie zatrzymuje usługę i usuwa program, ale celowo pozostawia konfigurację oraz kolejkę. Po sprawdzeniu kopii można je ręcznie usunąć:

```sh
sudo rm -rf /etc/stream-gps-device /var/lib/stream-gps-device
```

To ostatnie polecenie bezpowrotnie usuwa zapisany klucz i niewysłane punkty.

## Aktualizacja

Ponownie pobierz aktualny instalator, obejrzyj zmiany i uruchom go. Przed podmianą tworzona jest kopia konfiguracji. Aktualizacja BelaUI nie wymaga ponownej instalacji klienta Stream GPS.

## Najczęstsze problemy

- **No ModemManager modem detected** — sprawdź `systemctl status ModemManager` i `mmcli -L`.
- **Waiting for GPS fix** — sprawdź antenę GNSS, wyjdź na otwartą przestrzeń i poczekaj na cold start.
- **HTTP 401** — `DEVICE_ID` lub `DEVICE_KEY` są niepoprawne albo urządzenie zostało wyłączone. Wygeneruj nowy klucz na stronie Devices i wpisz go w panelu `:26666`.
- **HTTP 409** — żądanie zostało rozpoznane jako powtórzone; klient sam wygeneruje nowy nonce przy następnej próbie.
- **HTTP 429** — wysyłanie jest zbyt częste. Ustaw interwał co najmniej 2 sekundy.
- **Panel się nie otwiera** — sprawdź `sudo ss -ltnp | grep ':26666'`, zaporę sieciową i czy komputer jest w tej samej sieci.
