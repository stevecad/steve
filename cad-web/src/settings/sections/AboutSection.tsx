/**
 * Settings → About: this version of STEVE Studio, and the open-source engines it stands on (each credited and linked to
 * what STEVE actually runs: CadQuery is STEVE's fork, at the commit the geometry runtime was built from).
 */
import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { api } from '@/lib/api';
import { useApp } from '@/state/store';
import { cadquerySourceHref, engineCredits, registerCredit, settingsSections } from '../registry';
import { Card, SettingsPage } from '../ui';
import mark from '@/steve/mark.svg';
import styles from '../Settings.module.css';

const metadata = () => useApp.getState().displayed?.metadata;
registerCredit({ name: 'CadQuery (STEVE’s fork)', href: () => cadquerySourceHref(metadata()?.cadquery_source), license: 'Apache 2.0',
  credit: <>STEVE’s fork of CadQuery, the open-source parametric CAD library STEVE’s parts and designs are written in. Upstream: <a className={styles.link} href="https://github.com/CadQuery/cadquery" target="_blank" rel="noreferrer">CadQuery/cadquery</a>, by the CadQuery contributors.</>,
  version: () => metadata()?.cadquery_version ?? null });
registerCredit({ name: 'OCP (cadquery-ocp)', href: 'https://github.com/CadQuery/OCP', license: 'Apache 2.0',
  credit: 'The Python bindings to Open CASCADE that CadQuery runs on, by the CadQuery contributors.',
  version: () => metadata()?.ocp_version ?? null });
registerCredit({ name: 'Open CASCADE Technology', href: 'https://github.com/Open-Cascade-SAS/OCCT', license: 'LGPL 2.1',
  credit: 'The geometry kernel under CadQuery: solids, booleans, fillets, STEP.',
  version: () => metadata()?.occt_version ?? null });

export default function AboutSection() {
  const section = settingsSections().find((item) => item.id === 'about')!;
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<{ version?: string }>('/v1/feedback/config').then((reply) => { if (live) setVersion(reply.version?.trim() || null); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  return (
    <SettingsPage section={section}>
      <Card title="Steve" id="about-version"
        description={<span id="about-build">{version ? <>Build <code className={styles.inlineCode}>{version}</code></> : 'Local CAD · Studio-compatible runtime'}</span>}
        actions={<span className={styles.aboutMark}><img src={mark} alt="" /></span>}>
        <p className={styles.rowHint}>Steve builds and edits CAD on this machine.</p>
      </Card>
      <Card title="Built on open source" id="about-credits" description="STEVE stands on these engines. Each name opens the source STEVE runs.">
        {engineCredits().map((item) => (
          <div key={item.name} className={styles.credit} data-credit={item.name}>
            <a className={styles.link} href={typeof item.href === 'function' ? item.href() : item.href} target="_blank" rel="noreferrer"><b>{item.name}</b><ExternalLink size={11} /></a>
            <small>{item.version?.() ?? ''}{item.version?.() ? ' · ' : ''}{item.license}</small>
            <p>{item.credit}</p>
          </div>
        ))}
      </Card>
    </SettingsPage>
  );
}
