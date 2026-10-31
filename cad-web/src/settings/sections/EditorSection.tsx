/**
 * Settings → Code editor: the Source panel's building as you type (Live), and its text size.
 */
import { Slider, Switch } from '@/ui';
import { modKey } from '@/lib/format';
import { settingsSections } from '../registry';
import { updateSetting, useSetting } from '../store';
import { Card, Row, SettingsPage } from '../ui';
import styles from '../Settings.module.css';

export default function EditorSection() {
  const section = settingsSections().find((item) => item.id === 'editor')!;
  const live = useSetting('editor.liveBuild');
  const fontSize = useSetting('editor.fontSize');
  return (
    <SettingsPage section={section}>
      <Card title="Building" id="editor-build">
        <Row label="Build as you type (Live)" hint={`Rebuilds the model a moment after you stop typing, and after a tool changes the code. Off: build with Update model (${modKey}+Enter). The Source panel’s Live switch is the same setting.`} setting="editor.liveBuild">
          <Switch checked={live} onCheckedChange={(on) => void updateSetting('editor.liveBuild', on)} label="Build as you type" />
        </Row>
      </Card>
      <Card title="Text" id="editor-text">
        <Row label="Font size" hint="The Source panel’s code, in pixels." setting="editor.fontSize">
          <span className={styles.slider}><Slider label="Font size" value={fontSize} min={11} max={18} step={0.5} onChange={(value) => void updateSetting('editor.fontSize', Math.round(value * 2) / 2)} /></span>
          <span className={styles.value}>{fontSize} px</span>
        </Row>
        <pre className={styles.preview} style={{ fontSize }} aria-hidden="true">{'model.extrude("plate", "sketch_1", distance=thickness)'}</pre>
      </Card>
    </SettingsPage>
  );
}
