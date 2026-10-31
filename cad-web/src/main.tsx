import { useMotion } from '@/motion/state';
import './localDesktop';
import { applyThemeEarly } from './state/theme';
import { jointPick } from '@/motion/jointTool';
import { useSketch } from './sketch/session';
import { useSketchPicks } from './sketch/picking';
import { useFeatureDialog } from './modeling/dialog';
import { useSimulation } from './workspaces/simulate/state';
import { runCommand } from './commands';
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/base.css';
import './styles/desktop.css';
document.documentElement.dataset.localDesktop = 'true';
import App from './shell/App';
import { toast, useApp } from './state/store';
import { viewer } from './viewport/viewer';
import { setCode, updateModel } from './state/actions';
import { startAutoBuild } from './state/autobuild';
import { loadFeedbackConfig } from './feedback/feedback';
import { bootstrapAuth, retrySignIn, TEAMS_RETURN } from './auth/auth';
import { applyTeamParam, installEventSource, takeWorkspaceNotice } from './teams/current';
import { takeInviteFragment } from './teams/invite';
import BeforeYouStart from './terms/BeforeYouStart';
import { loadTerms, type Terms } from './terms/terms';
import { exportAnimatedGlb } from './motion/exportMotion';
import { usePresent } from './present/state';
import { pickIntoFrames, useFromPart } from './workspaces/manufacture/fromPart';
import { openPlayer, useCam, usePlayer } from './workspaces/manufacture/cam/state';
import { useStockView } from './workspaces/manufacture/cam/stockView';
import { useReferenceReview } from './workspaces/manufacture/cam/ReferenceReview';
import { useChecks } from './workspaces/manufacture/cam/checks';
import { loadLibrary, loadPrograms, selectProgram, useMfg } from './workspaces/manufacture/state';
import { importExamples, type ExampleSet } from './workspaces/manufacture/examples';
import { addToShop, useShop } from './workspaces/manufacture/shop/state';
import { useCamDoc } from './workspaces/manufacture/cam/camDoc';
import { circuitSelectionContext, showCircuit, useCircuit } from './workspaces/electronics/state';
import { usePcbEditState } from './workspaces/electronics/pcbEdits';
import { useRouting } from './workspaces/electronics/routing';
import { onSchematicDrag, onSchematicWire, useSchematicTool } from './workspaces/electronics/schematicEdits';
import { updateSettings, useSettings } from './settings/store';
import { installSettings } from './settings/install';
import { openSettings } from './settings/registry';
import { accountKey } from './state/accountStorage';
import { useDrawingTab } from './drawing/state';
import { useDrawingTool } from './drawing/tools';
import { includeOwnMaterials } from './lib/materials';
import { Plane, Raycaster, Vector2, Vector3 } from 'three';

// Test and debugging handle.
(window as unknown as { steve: unknown }).steve = { store: useApp, viewer, sketch: useSketch, sketchPicks: useSketchPicks, featureDialog: useFeatureDialog, simulation: useSimulation, motion: useMotion, motionExport: { glb: exportAnimatedGlb }, present: usePresent, joint: { pick: jointPick }, toolPart: { store: useFromPart, pick: pickIntoFrames }, cam: { store: useCam, checks: useChecks, player: usePlayer, openPlayer, stockView: useStockView, references: useReferenceReview, mfg: { store: useMfg, shop: useShop, addToShop, camDoc: useCamDoc, load: loadPrograms, select: selectProgram, examples: (set: ExampleSet) => importExamples(set).then(async (made) => { await loadLibrary(); return made.length; }) } }, circuit: { store: useCircuit, show: showCircuit, edits: usePcbEditState, routing: useRouting, context: circuitSelectionContext, pcbToScreen: async (x: number, y: number) => (await import('./workspaces/electronics/pcbCamera')).pcbToScreen(x, y), schematic: { tool: useSchematicTool, onDrag: onSchematicDrag, onWire: onSchematicWire } }, actions: { setCode, updateModel }, drawing: { tab: useDrawingTab, tool: useDrawingTool }, run: runCommand, settings: { store: useSettings, open: openSettings, update: updateSettings }, accountKey, three: { Plane, Raycaster, Vector2, Vector3 } };

applyThemeEarly();
// Teams (docs/TEAMS.md): a deep link's team chooses this tab's workspace, and streams ask in it (teams/current.ts).
applyTeamParam();
takeInviteFragment();   // an invitation link's code: out of the address at once (teams/invite.ts)
installEventSource();

// Accounts (docs/ACCOUNTS.md): signed in (or dev mode) before anything loads data.
// An OAuth app's authorization request (/oauth/authorize → /#oauth?…), kept across sign-in for the consent dialog.
// Taken once: the hash is cleared at once, so a reload or a sign-in never brings back a request the dialog dropped.
// Only the parameters STEVE reads, and only a request of ordinary size (one is a few hundred characters): a crafted
// link can't fill the browser's storage through the sign-in state that carries it (auth/auth.ts).
if (location.hash.startsWith('#oauth?')) {
  const known = ['client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'response_type'];
  const asked = new URLSearchParams(location.hash.slice('#oauth?'.length));
  const kept = new URLSearchParams([...asked].filter(([key]) => known.includes(key))).toString();
  // The server's limits (app/oauth_api.py): a request over them, made by hand as a link, can't be answered.
  const answerable = JSON.stringify(kept).length <= 4096 && [...(asked.get('state') ?? '')].length <= 500;   // characters, as the server counts   // as auth.ts's small()
  try {
    if (answerable) sessionStorage.setItem('steve.oauthRequest', kept);
    else sessionStorage.removeItem('steve.oauthRequest');   // never an earlier request in its place
  } catch { /* storage off: the request is lost */ }
  history.replaceState(null, '', location.pathname + location.search);
}
// Back from GitHub or GitLab after connecting version control (app/git_sync.py forwards their return here, in the
// fragment): kept for Settings → Version control to finish, signed in. Only its own parameters, of ordinary size.
if (location.hash.startsWith('#git-connect?')) {
  const known = ['provider', 'state', 'code', 'installation_id', 'setup_action', 'error'];
  const kept = new URLSearchParams([...new URLSearchParams(location.hash.slice('#git-connect?'.length))]
    .filter(([key, value]) => known.includes(key) && value.length <= 500)).toString();
  try { sessionStorage.setItem('steve.gitConnect', kept); } catch { /* storage off: the person connects again */ }
  history.replaceState(null, '', location.pathname + location.search);
}
// Back from RMFG's sign-in (app/rmfg.py forwards its return here, in the fragment): kept for Settings → RMFG to finish.
if (location.hash.startsWith('#rmfg-connect?')) {
  const known = ['state', 'code', 'error', 'iss'];
  const kept = new URLSearchParams([...new URLSearchParams(location.hash.slice('#rmfg-connect?'.length))]
    .filter(([key, value]) => known.includes(key) && value.length <= 500)).toString();
  try { sessionStorage.setItem('steve.rmfgConnect', kept); } catch { /* storage off: the person signs in again */ }
  history.replaceState(null, '', location.pathname + location.search);
}
// Back from an outside MCP server's sign-in (app/mcp_servers.py forwards its return here, in the fragment): kept for
// Settings → MCP servers to finish, signed in.
if (location.hash.startsWith('#mcp-connect?')) {
  const known = ['state', 'code', 'error'];
  const kept = new URLSearchParams([...new URLSearchParams(location.hash.slice('#mcp-connect?'.length))]
    .filter(([key, value]) => known.includes(key) && value.length <= 500)).toString();
  try { sessionStorage.setItem('steve.mcpConnect', kept); } catch { /* storage off: the person signs in again */ }
  history.replaceState(null, '', location.pathname + location.search);
}
// A connect link followed inside a tab that already has STEVE open changes only the hash: load again so the request
// is taken (above) and its dialog shown now, not at some later reload.
window.addEventListener('hashchange', () => {
  if (location.hash.startsWith('#oauth?') || location.hash.startsWith('#team-invite=')) location.reload();
});
// STEVE's terms (app/terms.py): a person agrees on the "Before you start" page before the app opens.
async function termsToAccept(): Promise<Terms | null> {
  try {
    const terms = await loadTerms();
    return terms.required && !terms.accepted ? terms : null;
  } catch {
    return null;   // a server from before the terms: the app opens (the server still refuses what needs them)
  }
}

void bootstrapAuth().then(async () => {
  const terms = await termsToAccept();
  const root = createRoot(document.getElementById('root')!);
  if (terms) root.render(<StrictMode><BeforeYouStart terms={terms} onAccepted={() => startApp(root)} /></StrictMode>);
  else startApp(root);
}, (error: unknown) => {
  // Signing in couldn't finish (or the server couldn't be reached): say so with a way out, never a blank page.
  console.error(error);
  createRoot(document.getElementById('root')!).render(<SignInProblem />);
});

function startApp(root: Root) {
  installSettings();  // The account's settings, before anything they shape (settings/install.ts).
  includeOwnMaterials();  // The person's own materials join the material library (app/user_materials.py).
  root.render(<StrictMode><App /></StrictMode>);
  startAutoBuild();
  // Back from the sign-in that confirms deleting the account: Settings → Account carries on (sections/AccountSection.tsx).
  try {
    const at = Number(sessionStorage.getItem('steve.pendingDeletion'));
    if (at && Date.now() - at < 10 * 60_000) openSettings('account');   // it asks "Continue deleting?": never deletes by itself
    if (sessionStorage.getItem('steve.gitConnect')) openSettings('version-control');   // it finishes connecting GitHub or GitLab
    if (sessionStorage.getItem('steve.mcpConnect')) openSettings('mcp-servers');   // it finishes signing in to an MCP server
    if (sessionStorage.getItem('steve.rmfgConnect')) openSettings('rmfg');   // it finishes signing in to RMFG
    if (sessionStorage.getItem(TEAMS_RETURN)) {   // back from the MFA sign-in a team asked for: review and repeat there
      sessionStorage.removeItem(TEAMS_RETURN);
      openSettings('teams');
    }
  } catch { /* Storage is optional. */ }
  void loadFeedbackConfig();  // "Report a bug" shows when reports can reach STEVE Studio, or after signing in (local_feedback.py).
  if (takeWorkspaceNotice()) toast('info', 'Back in Personal', 'You’re no longer a member of the team this tab was working in.');
}

function SignInProblem() {
  return (
    <div id="sign-in-problem" role="alert" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24, textAlign: 'center', background: 'var(--bg-1)', color: 'var(--text-1)', fontFamily: 'var(--font-sans)' }}>
      <div style={{ fontSize: 16, fontWeight: 600 }}>{"Couldn't finish signing you in."}</div>
      <div style={{ fontSize: 13, color: 'var(--text-2)', maxWidth: 360 }}>Your work is safe. Try again to pick up where you left off.</div>
      <button type="button" onClick={retrySignIn} style={{ font: 'inherit', fontSize: 14, padding: '8px 18px', borderRadius: 6, border: '1px solid var(--bg-5)', background: 'var(--bg-3)', color: 'var(--text-1)', cursor: 'pointer' }}>Try again</button>
    </div>
  );
}
