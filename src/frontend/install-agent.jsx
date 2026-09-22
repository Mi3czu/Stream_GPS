import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

const installScriptUrl = 'https://raw.githubusercontent.com/Mi3czu/Stream_GPS/main/installer/install-device.sh';
const quickInstallCommand = `curl -fsSL ${installScriptUrl} -o /tmp/install-stream-gps-device.sh && sudo sh /tmp/install-stream-gps-device.sh`;

const CopyCommand = ({ children, label = 'Copy' }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return <div className="install-command"><code>{children}</code><button type="button" className="button--secondary button--small" onClick={copy}>{copied ? 'Copied' : label}</button></div>;
};

const InstallAgent = () => {
  const platformUrl = useMemo(() => window.location.origin, []);

  return (
    <main className="install-page">
      <header className="page-header install-page__header">
        <div><h1>Install device agent</h1><p>Connect a GPS modem without modifying the existing device software.</p></div>
        <Link className="button button--secondary" to="/devices">Manage devices</Link>
      </header>

      <section className="panel install-intro">
        <div className="install-intro__icon" aria-hidden="true">⌁</div>
        <div><h2>Your standalone device integration</h2><p>The agent runs as its own system service and local configuration panel on port <code>26666</code>. It stays separate from the existing device software and its updates.</p></div>
      </section>

      <section className="install-steps" aria-label="Device agent installation steps">
        <article className="panel install-step">
          <span className="install-step__number">1</span>
          <div><h2>Create a device</h2><p>Open <Link to="/devices">Devices</Link>, create a GPS device, then retain its <code>DEVICE_ID</code> and <code>DEVICE_KEY</code>. The key is needed by the installer and must not be shared publicly.</p></div>
        </article>

        <article className="panel install-step">
          <span className="install-step__number">2</span>
          <div><h2>Connect to the device computer via SSH</h2><p>First enable or start SSH access in the device's own administration interface. From a computer on the same trusted network, open Windows PowerShell or PuTTY and connect using the device IP address:</p><CopyCommand>{'ssh user@<computer_ip>'}</CopyCommand><p className="panel__hint">In PuTTY, select <strong>SSH</strong>, enter <code>&lt;computer_ip&gt;</code> as the host, then sign in as <code>user</code>. Use the SSH password shown or configured in the device administration interface.</p><p>After signing in, confirm the modem is visible before installing:</p><CopyCommand>{'mmcli -L'}</CopyCommand><p className="panel__hint">A modem such as <code>/Modem/0</code> should appear. The unit needs a GNSS-capable modem and an antenna connected to its GNSS port.</p></div>
        </article>

        <article className="panel install-step">
          <span className="install-step__number">3</span>
          <div><h2>Install the agent</h2><p>Copy this command into the SSH terminal. The installer asks only for a password to protect the local panel — platform credentials are entered later in the browser.</p><div className="install-option install-option--recommended"><CopyCommand>{quickInstallCommand}</CopyCommand></div></div>
        </article>

        <article className="panel install-step">
          <span className="install-step__number">4</span>
          <div><h2>Connect the platform in the local panel</h2><p>The installer asks only for a local-panel password. Open the panel in step 5, then enter this platform address and the device credentials from step 1. Use <strong>Test connection</strong> before saving.</p><CopyCommand label="Copy platform address">{platformUrl}</CopyCommand><p className="panel__hint">Enter only the base address — do not add an API path. Leading and trailing spaces are removed with a visible notice, and credentials are saved only after the test succeeds.</p></div>
        </article>

        <article className="panel install-step">
          <span className="install-step__number">5</span>
          <div><h2>Open the local agent panel</h2><p>Use the same IP address that you used for SSH, adding port <code>26666</code>. Open it from a device connected to the same Wi-Fi or hotspot:</p><div className="install-address">{'http://<computer_ip>:26666'}</div><p className="panel__hint">Sign in with <code>admin</code> and the local-panel password chosen during installation. Do not forward port 26666 to the internet.</p></div>
        </article>
      </section>

      <details className="panel collapsible-panel install-troubleshooting">
        <summary className="collapsible-panel__summary"><div><h2>Checks and troubleshooting</h2><p>Useful commands after installation.</p></div></summary>
        <div className="collapsible-panel__content install-checks">
          <div><strong>Agent status</strong><CopyCommand>{'sudo stream-gps-device status'}</CopyCommand></div>
          <div><strong>Full GPS and upload test</strong><CopyCommand>{'sudo stream-gps-device test'}</CopyCommand></div>
          <div><strong>Recent agent logs</strong><CopyCommand>{'sudo stream-gps-device logs'}</CopyCommand></div>
          <div><strong>Live logs</strong><CopyCommand>{'sudo stream-gps-device follow'}</CopyCommand></div>
        </div>
      </details>
    </main>
  );
};

export default InstallAgent;
