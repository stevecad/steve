/**
 * Settings → Display: how a model looks when STEVE opens. The view bar still changes the look for the moment; this is
 * what it starts as.
 */
import { Segmented, Select, Switch } from '@/ui';
import type { DisplayStyle, Projection, ViewportBackground } from '@/state/store';
import type { Units } from '@/lib/format';
import { settingsSections } from '../registry';
import { updateSetting, useSetting } from '../store';
import { Card, Row, SettingsPage } from '../ui';

const STYLES: { value: DisplayStyle; label: string }[] = [
  { value: 'shaded-edges', label: 'Shaded with edges' },
  { value: 'shaded', label: 'Shaded' },
  { value: 'hidden-line', label: 'Hidden lines' },
  { value: 'wireframe', label: 'Wireframe' },
  { value: 'xray', label: 'X-ray' },
];

const BACKGROUNDS: { value: ViewportBackground; label: string }[] = [
  { value: 'theme', label: 'Match the theme' },
  { value: 'light', label: 'Light grey' },
  { value: 'dark', label: 'Dark' },
];

export default function DisplaySection() {
  const section = settingsSections().find((item) => item.id === 'display')!;
  const style = useSetting('display.style');
  const projection = useSetting('display.projection');
  const grid = useSetting('display.grid');
  const shadows = useSetting('display.shadows');
  const origin = useSetting('display.originPlanes');
  const background = useSetting('display.background');
  const units = useSetting('display.units');
  return (
    <SettingsPage section={section}>
      <Card title="When a model opens" id="display-defaults" description="Changes here apply right away; the view bar still changes them while you work.">
        <Row label="Style" hint="How surfaces and edges are drawn." setting="display.style">
          <Select ariaLabel="Display style" value={style} options={STYLES} onChange={(value) => void updateSetting('display.style', value as DisplayStyle)} />
        </Row>
        <Row label="Projection" hint="Orthographic keeps parallel lines parallel, as on a drawing; perspective looks as your eye sees it." setting="display.projection">
          <Segmented size="sm" value={projection} onChange={(value: Projection) => void updateSetting('display.projection', value)}
            options={[{ value: 'orthographic', label: 'Orthographic' }, { value: 'perspective', label: 'Perspective' }]} />
        </Row>
        <Row label="Grid" hint="The ground grid under the model." setting="display.grid">
          <Switch checked={grid} onCheckedChange={(on) => void updateSetting('display.grid', on)} label="Grid" />
        </Row>
        <Row label="Shadows" hint="A soft shadow under the model." setting="display.shadows">
          <Switch checked={shadows} onCheckedChange={(on) => void updateSetting('display.shadows', on)} label="Shadows" />
        </Row>
        <Row label="Origin planes" hint="The XY, XZ and YZ planes at the origin." setting="display.originPlanes">
          <Switch checked={origin} onCheckedChange={(on) => void updateSetting('display.originPlanes', on)} label="Origin planes" />
        </Row>
        <Row label="Background" hint="The 3D view's backdrop. Light grey shows light-coloured parts better and suits screenshots." setting="display.background">
          <Select ariaLabel="Background" value={background} options={BACKGROUNDS}
            onChange={(value) => void updateSetting('display.background', value as ViewportBackground)} />
        </Row>
      </Card>
      <Card title="Units" id="display-units" description="Clicking the units in the status bar switches them too. Models and their code stay in millimetres.">
        <Row label="Lengths" hint="Lengths, areas and volumes shown in the 3D view, Measure, Properties and sketches. A plain number typed in a sketch is in this unit; models stay in mm." setting="display.units">
          <Segmented size="sm" value={units} onChange={(value: Units) => { void updateSetting('display.units', value); }}
            options={[{ value: 'mm', label: 'Millimetres' }, { value: 'in', label: 'Inches' }]} />
        </Row>
      </Card>
    </SettingsPage>
  );
}
