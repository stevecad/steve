import { useState } from 'react';
import { Popover } from 'radix-ui';
import { SpaceMouseIcon } from '@/icons/cad';
import { Button, Slider, Switch, Tip } from '@/ui';
import ui from '@/ui/ui.module.css';
import { connectSpaceMouse, disconnectSpaceMouse, updateSpaceMouseSettings, useSpaceMouse, type SpaceMouseSettings } from './spacemouse';
import styles from './Viewport.module.css';

export const TOGGLES: { key: keyof SpaceMouseSettings; label: string }[] = [
  { key: 'invertRotate', label: 'Invert rotation' },
  { key: 'invertPan', label: 'Invert pan' },
  { key: 'invertZoom', label: 'Invert zoom' },
  { key: 'lockRotation', label: 'Lock rotation' },
  { key: 'lockPan', label: 'Lock pan and zoom' },
  { key: 'dominant', label: 'Dominant axis only' },
];

/** Nav-bar control for connecting and tuning a 3Dconnexion SpaceMouse. */
export default function SpaceMousePanel() {
  const { status, device, active, settings, error } = useSpaceMouse();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const connected = status === 'connected';
  return (
    <Popover.Root>
      <Tip label="SpaceMouse" description={connected ? `${device} connected` : status === 'unsupported' ? 'SpaceMouse works in Chrome and Edge' : 'Connect a 3Dconnexion SpaceMouse'}>
        <Popover.Trigger asChild>
          <button type="button" className={`${ui.iconButton} ${styles.spaceMouseButton}`} data-active={connected || undefined} data-moving={active || undefined} aria-label="SpaceMouse">
            <SpaceMouseIcon />
          </button>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content className={`${ui.menu} ${styles.spaceMousePanel}`} side="top" sideOffset={12} collisionPadding={12}>
          <div className={styles.smHeader}>
            <SpaceMouseIcon size={18} />
            <div>
              <div className={styles.smTitle}>SpaceMouse</div>
              <div className={styles.smStatus} data-state={status}>
                {connected ? `${device}${active ? ' · moving' : ' · ready'}` : status === 'insecure' ? 'Needs a secure connection' : status === 'unsupported' ? 'Not supported in this browser' : 'Not connected'}
              </div>
            </div>
          </div>
          {status === 'insecure' ? (
            <p className={styles.smHelp}>
              Browsers only allow 3D mice on secure pages. Open STEVE through <b>https</b> (for example behind your reverse proxy) or on <b>http://localhost</b>. In Chrome you can also add this address under <span className="mono">chrome://flags/#unsafely-treat-insecure-origin-as-secure</span>.
            </p>
          ) : (
            <>
              <div className={styles.smRow}>
                {connected
                  ? <Button size="sm" variant="ghost" onClick={() => { void disconnectSpaceMouse(); }}>Disconnect</Button>
                  : <Button size="sm" variant="primary" disabled={busy || status === 'unsupported'} onClick={async () => { setBusy(true); setMessage(await connectSpaceMouse()); setBusy(false); }}>Connect device…</Button>}
              </div>
              {!connected && (message || error) && <p className={styles.smHelp} data-tone="warning">{message || error}</p>}
              {status === 'unsupported' && <p className={styles.smHelp} data-tone="warning">This browser can’t connect to a SpaceMouse. SpaceMouse works in <b>Chrome</b> and <b>Edge</b>.</p>}
              <div className={styles.smField}>
                <span>Speed</span>
                <Slider label="SpaceMouse speed" value={settings.sensitivity} min={0.2} max={3} step={0.05} onChange={(sensitivity) => updateSpaceMouseSettings({ sensitivity })} />
                <span className="tnum" style={{ width: 34, textAlign: 'right' }}>{settings.sensitivity.toFixed(1)}×</span>
              </div>
              <div className={styles.smToggles}>
                {TOGGLES.map((toggle) => (
                  <label key={toggle.key} className={styles.smToggle}>
                    <span>{toggle.label}</span>
                    <Switch label={toggle.label} checked={!!settings[toggle.key]} onCheckedChange={(checked) => updateSpaceMouseSettings({ [toggle.key]: checked })} />
                  </label>
                ))}
              </div>
              <p className={styles.smHelp}>Moves the model with the cap (object mode). Left button: home view. Right button: fit. On Linux, the device’s hidraw node must be readable by your user. On macOS and Windows, quit the 3Dconnexion driver (3DxWare) first: while it runs, it keeps the device to itself.</p>
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
