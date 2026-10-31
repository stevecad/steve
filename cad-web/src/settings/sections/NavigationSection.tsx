/**
 * Settings → Navigation: how the mouse wheel, drags and a SpaceMouse move the view.
 * Preferences are local; SpaceMouse settings are shared with the view bar's popover.
 */
import { Slider, Switch } from '@/ui';
import { MOUSE_STYLES, mouseStyleInfo } from '@/viewport/mouseStyle';
import { updateSpaceMouseSettings, useSpaceMouse } from '@/viewport/spacemouse';
import { TOGGLES } from '@/viewport/SpaceMousePanel';
import { settingsSections } from '../registry';
import { updateSetting, useSetting } from '../store';
import { Card, ChoiceCards, Note, Row, SettingsPage } from '../ui';
import styles from '../Settings.module.css';


function Speed({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return (
    <>
      <span className={styles.slider}><Slider label={label} value={value} min={min} max={max} step={step} onChange={onChange} /></span>
      <span className={styles.value}>{value.toFixed(2).replace(/0$/, '')}×</span>
    </>
  );
}

export default function NavigationSection() {
  const section = settingsSections().find((item) => item.id === 'navigation')!;
  const zoomSpeed = useSetting('viewport.zoomSpeed');
  const invertWheel = useSetting('viewport.invertWheel');
  const zoomToCursor = useSetting('viewport.zoomToCursor');
  const orbitSpeed = useSetting('viewport.orbitSpeed');
  const mouseStyle = useSetting('viewport.mouseStyle');
  const spacemouse = useSpaceMouse((state) => state.settings);
  const status = useSpaceMouse((state) => state.status);
  return (
    <SettingsPage section={section}>
      <Card title="Mouse and trackpad" id="nav-mouse" description={`${mouseStyleInfo(mouseStyle).summary} Preferences stay on this machine.`}>
        <ChoiceCards label="Mouse style" value={mouseStyle} options={MOUSE_STYLES.map(item => ({ ...item, label: item.value === 'steve' ? 'Steve' : item.label, description: item.summary }))}
          onChange={value => void updateSetting('viewport.mouseStyle', value)} />
        <Note>Mouse presets save automatically. Keyboard shortcuts are configured separately. In a sketch, the left button always draws.</Note>
        <Row label="Zoom speed" hint="How far each wheel notch or trackpad scroll zooms. 1× is about 15% a notch." setting="viewport.zoomSpeed">
          <Speed label="Zoom speed" value={zoomSpeed} min={0.25} max={3} step={0.05} onChange={(value) => void updateSetting('viewport.zoomSpeed', Math.round(value * 20) / 20)} />
        </Row>
        <Row label="Invert wheel zoom" hint="Scrolling down zooms in instead of out." setting="viewport.invertWheel">
          <Switch checked={invertWheel} onCheckedChange={(on) => void updateSetting('viewport.invertWheel', on)} label="Invert wheel zoom" />
        </Row>
        <Row label="Zoom toward the pointer" hint="Zoom about what’s under the pointer. Off: zoom about the middle of the view." setting="viewport.zoomToCursor">
          <Switch checked={zoomToCursor} onCheckedChange={(on) => void updateSetting('viewport.zoomToCursor', on)} label="Zoom toward the pointer" />
        </Row>
        <Row label="Orbit speed" hint="How far a drag turns the model. 1× is a full turn across the view’s height." setting="viewport.orbitSpeed">
          <Speed label="Orbit speed" value={orbitSpeed} min={0.25} max={3} step={0.05} onChange={(value) => void updateSetting('viewport.orbitSpeed', Math.round(value * 20) / 20)} />
        </Row>
      </Card>
      <Card title="SpaceMouse" id="nav-spacemouse" description="3Dconnexion devices, in Chrome and Edge. Connect one from the view bar’s SpaceMouse button; these settings stay with this browser.">
        {status === 'unsupported' && <Note tone="warning">This browser can’t connect to a SpaceMouse. SpaceMouse works in <b>Chrome</b> and <b>Edge</b>.</Note>}
        <Row label="Speed" hint="How fast the cap moves the model.">
          <Speed label="SpaceMouse speed" value={spacemouse.sensitivity} min={0.2} max={3} step={0.05} onChange={(sensitivity) => updateSpaceMouseSettings({ sensitivity })} />
        </Row>
        {TOGGLES.map((toggle) => (
          <Row key={toggle.key} label={toggle.label}>
            <Switch label={toggle.label} checked={!!spacemouse[toggle.key]} onCheckedChange={(checked) => updateSpaceMouseSettings({ [toggle.key]: checked })} />
          </Row>
        ))}
      </Card>
    </SettingsPage>
  );
}
