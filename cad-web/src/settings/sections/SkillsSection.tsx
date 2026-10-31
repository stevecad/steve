/**
 * Settings → Skills: what STEVE can load when a task needs it (docs/SKILLS.md). Built-in skills can be switched off or
 * copied to edit (the copy replaces the built-in); your own are written and edited here.
 */
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Copy, Plus, Save, Trash2 } from 'lucide-react';
import { Button, Switch } from '@/ui';
import { Api, type SkillDetail, type SkillSummary } from '@/lib/api';
import { toast } from '@/state/store';
import SkillEditor from '@/panels/SkillEditor';
import styles from '@/panels/Assistant.module.css';
import own from '@/panels/Steve.module.css';
import { settingsSections } from '../registry';
import { Card, SettingsPage } from '../ui';
import page from '../Settings.module.css';
import { askConfirm } from '@/ui/confirm';

const TEMPLATE = (name: string) => `---
name: ${name || 'my-skill'}
description: >-
  What this skill covers and when STEVE should load it, in one or two sentences.
  STEVE sees only this description until it loads the skill.
---

# ${name || 'My skill'}

Instructions STEVE follows once it loads this skill: rules, dimensions, steps, examples.
`;

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function Badge({ skill }: { skill: SkillSummary }) {
  if (skill.source === 'builtin') return <span className={own.badge} data-kind="builtin">Built-in</span>;
  return <span className={own.badge} data-kind="user">{skill.overrides_builtin ? 'Yours · replaces built-in' : 'Yours'}</span>;
}

type View = { mode: 'list' } | { mode: 'open'; name: string } | { mode: 'new' };

export default function SkillsSection() {
  const section = settingsSections().find((item) => item.id === 'skills')!;
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>({ mode: 'list' });
  const load = useCallback(async () => {
    try { setSkills((await Api.skills()).skills); setError(''); } catch (caught) { setError((caught as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const toggle = async (skill: SkillSummary, enabled: boolean) => {
    setSkills((old) => old?.map((item) => (item.name === skill.name ? { ...item, enabled } : item)) ?? old);
    try { await Api.toggleSkill(skill.name, enabled); } catch (caught) { setError((caught as Error).message); void load(); }
  };
  const builtIn = skills?.filter((skill) => skill.source === 'builtin') ?? [];
  const yours = skills?.filter((skill) => skill.source !== 'builtin') ?? [];
  const row = (skill: SkillSummary) => (
    <div key={skill.name} role="listitem" className={own.skill} data-skill={skill.name} data-enabled={skill.enabled || undefined}>
      <button type="button" className={own.skillMain} onClick={() => setView({ mode: 'open', name: skill.name })}>
        <span className={own.skillName}><code>{skill.name}</code><Badge skill={skill} /></span>
        <span className={own.skillDescription}>{skill.description}</span>
      </button>
      <Switch checked={skill.enabled} onCheckedChange={(on) => void toggle(skill, on)} label={`${skill.name} on`} />
    </div>
  );

  return (
    <SettingsPage section={section} id="steve-skills" actions={view.mode === 'list' ? <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setView({ mode: 'new' })} id="new-skill">New skill</Button> : undefined}>
      <div className={page.skills}>
        {view.mode === 'list' ? (
          <>
            {error && <p className={styles.error} role="alert">{error}</p>}
            {!skills && !error && <p className={own.hint}>Loading skills…</p>}
            {skills && (
              <Card title="Your skills" description="Rules, steps and know-how you write once; STEVE loads them when a task needs them. A copy of a built-in replaces it.">
                <div className={own.skills} role="list" data-list="yours">
                  {yours.length ? yours.map(row) : <p className={own.hint} style={{ padding: '4px 6px 10px' }}>None yet. New skill starts one from a template.</p>}
                </div>
              </Card>
            )}
            {skills && (
              <Card title="Built-in skills" description={`STEVE sees each skill’s name and description, and loads its instructions when a task needs them. ${builtIn.filter((skill) => skill.enabled).length} of ${builtIn.length} on.`}>
                <div className={own.skills} role="list" data-list="builtin">{builtIn.map(row)}</div>
              </Card>
            )}
          </>
        ) : (
          <Card title={view.mode === 'open' ? view.name : 'New skill'}>
            <div className={page.skillPage}>
              <SkillPage key={view.mode === 'open' ? view.name : 'new'} name={view.mode === 'open' ? view.name : null} onBack={() => { setView({ mode: 'list' }); void load(); }}
                onOpen={(name) => setView({ mode: 'open', name })} />
            </div>
          </Card>
        )}
      </div>
    </SettingsPage>
  );
}

/** One skill: its SKILL.md, editable when it's yours; a new skill when `name` is null. */
function SkillPage({ name, onBack, onOpen }: { name: string | null; onBack: () => void; onOpen: (name: string) => void }) {
  const [skill, setSkill] = useState<SkillDetail | null>(null);
  const [text, setText] = useState(name ? '' : TEMPLATE(''));
  const [newName, setNewName] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!name) return;
    let cancelled = false;
    Api.skill(name).then((value) => { if (!cancelled) { setSkill(value); setText(value.markdown); } }).catch((caught) => setError((caught as Error).message));
    return () => { cancelled = true; };
  }, [name]);
  const editable = !name || skill?.source === 'user';
  const dirty = !!skill && text !== skill.markdown;

  const save = async () => {
    if (saving || !editable) return;
    setSaving(true); setError('');
    try {
      if (!name) {
        const created = await Api.createSkill(newName, text.replace(/^name: .*$/m, `name: ${newName}`));
        toast('success', 'Skill created', `STEVE can load ${created.name} from its next message.`);
        onOpen(created.name);
      } else {
        const saved = await Api.updateSkill(name, text, skill!.enabled);
        setSkill(saved); setText(saved.markdown);
        toast('success', 'Skill saved', `${name} applies from STEVE’s next message.`);
      }
    } catch (caught) { setError((caught as Error).message); }
    finally { setSaving(false); }
  };
  const duplicate = async () => {
    if (!skill) return;
    setSaving(true); setError('');
    try {
      const copy = await Api.createSkill(skill.name, skill.markdown);
      setSkill(copy); setText(copy.markdown);
      toast('success', 'Your copy replaces the built-in', 'Edit it here; delete it to go back to the built-in.');
    } catch (caught) { setError((caught as Error).message); }
    finally { setSaving(false); }
  };
  const remove = async () => {
    if (!skill || !await askConfirm(skill.overrides_builtin ? { title: `Delete your copy of ${skill.name}?`, detail: 'The built-in skill comes back.', action: 'Delete' }
      : { title: `Delete ${skill.name}?`, action: 'Delete' })) return;
    try { await Api.deleteSkill(skill.name); onBack(); } catch (caught) { setError((caught as Error).message); }
  };
  const nameOk = NAME.test(newName) && newName.length <= 64;

  return (
    <>
      <div className={own.head}>
        <button type="button" className={own.back} onClick={onBack} aria-label="Back to skills"><ArrowLeft size={14} /></button>
        <b>{name ? <code>{name}</code> : 'New skill'}</b>
        {skill && <Badge skill={skill} />}
      </div>
      {!name && (
        <label className={own.nameField}>
          <span>Name</span>
          <input value={newName} placeholder="e.g. shop-bend-rules" maxLength={64} spellCheck={false} id="skill-name"
            onChange={(event) => setNewName(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} data-invalid={(newName && !nameOk) || undefined} />
        </label>
      )}
      {skill?.source === 'builtin' && <p className={own.note} role="status">Built-in skills are read-only. Duplicate it to make your own copy, which replaces it.</p>}
      {error && <p className={styles.error} role="alert" id="skill-error">{error}</p>}
      <div className={own.editorWrap}>
        {(skill || !name) && <SkillEditor value={text} onChange={setText} onSave={() => void save()} readOnly={!editable} label="SKILL.md" />}
      </div>
      <div className={own.footer}>
        {skill?.source === 'builtin' && <Button size="sm" icon={<Copy />} onClick={() => void duplicate()} disabled={saving} id="duplicate-skill">Duplicate to edit</Button>}
        {skill?.source === 'user' && <Button size="sm" variant="danger" icon={<Trash2 />} onClick={() => void remove()} id="delete-skill">Delete</Button>}
        <span className={own.spacer} />
        {editable && <span className={own.hint}>{name ? (dirty ? 'Unsaved changes' : 'Saved') : 'Ctrl+S saves'}</span>}
        {editable && <Button size="sm" variant="primary" icon={<Save />} onClick={() => void save()} disabled={saving || (name ? !dirty : !nameOk)} id="save-skill">{name ? 'Save' : 'Create'}</Button>}
      </div>
    </>
  );
}
