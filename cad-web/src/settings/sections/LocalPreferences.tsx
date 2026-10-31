import { Button } from '@/ui';
import { Card, Row, SettingsPage } from '../ui';
import { openSettings, settingsSections } from '../registry';
import LocalAccount from './LocalAccount';
import LocalDiagnostics from './LocalDiagnostics';
export default function LocalPreferences() {
 return <SettingsPage section={settingsSections().find(s => s.id === 'steve')!}>
  <LocalAccount />
  <Card title="How Steve works" description="Manage the tools and context Steve uses on this machine.">
   <Row label="Tools & MCP" hint="File workspace, connected servers and browser sign-in."><Button onClick={()=>openSettings('local-mcp')}>Manage tools</Button></Row>
   <Row label="Instructions" hint="Your system prompt and script execution preferences."><Button onClick={()=>openSettings('local-instructions')}>Edit instructions</Button></Row>
   <Row label="Skills & memory" hint="Trusted skill libraries and notes retained across conversations."><Button onClick={()=>openSettings('local-skills')}>Skills</Button><Button onClick={()=>openSettings('local-memory')}>Memory</Button></Row>
  </Card>
  <LocalDiagnostics />
 </SettingsPage>;
}
