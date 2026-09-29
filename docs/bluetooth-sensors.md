# Optional Bluetooth sensors

Bluetooth is optional. Stream GPS GPS tracking works without it. A new installation keeps Bluetooth sensors disabled, so a computer with no Bluetooth adapter, firmware or libraries does not show Bluetooth errors or perform scans.

## Enable from the local panel

1. Open `http://<computer-ip>:26666` and sign in.
2. Open **Bluetooth sensors (beta)**.
3. Select **Install Bluetooth support**. This installs `bluez`, `rfkill`, `python3-pip` and Python package `bleak`.
4. Select **Enable Bluetooth sensors**.
5. Use **Scan again**, then select and save the required heart-rate, cadence or power sensor.

Use **Disable Bluetooth sensors** to stop all sensor connections, scans and automatic reconnects. It does not uninstall packages or change firmware, so enabling the module again does not require a new installation.

The agent does not require manual pairing with `bluetoothctl`. It validates the standard BLE profile for the selected slot and reconnects after restarts or temporary signal loss.

The same optional installer can be started through SSH:

```sh
sudo /opt/stream-gps-device/install-bluetooth-support.sh
```

## Radxa 5B+ / Realtek RTL8852BE firmware recovery

Use this section only when the controller exists in `bluetoothctl list`, but scanning finds no nearby devices. First inspect:

```sh
sudo dmesg | grep -Ei 'bluetooth|btusb|rtl'
```

Messages such as `rtl8852bu_fw failed` or `load firmware failed` mean the Realtek firmware is missing. On the BELABOX image used with this adapter:

```sh
sudo mkdir -p /etc/modprobe.d
sudo sh -c 'printf "%s\n" "blacklist btusb" "blacklist btrtl" "blacklist btbcm" "blacklist btintel" > /etc/modprobe.d/belabox-rtl8852be-bt.conf'
cd /tmp
wget -O rtl8852bu_fw https://raw.githubusercontent.com/radxa/rtkbt/main/rtkbt-firmware/lib/firmware/rtl8852bu_fw
wget -O rtl8852bu_config https://raw.githubusercontent.com/radxa/rtkbt/main/rtkbt-firmware/lib/firmware/rtl8852bu_config
sudo install -m 644 rtl8852bu_fw /lib/firmware/rtl8852bu_fw
sudo install -m 644 rtl8852bu_config /lib/firmware/rtl8852bu_config
sudo reboot
```

After reboot, `bluetoothctl scan on` should find devices and the kernel log should include `Rtk patch end 0`.

Do not apply this blacklist to another Bluetooth chipset; use that device manufacturer's driver and firmware instead.
