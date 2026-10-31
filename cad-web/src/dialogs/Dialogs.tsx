import BlenderRenders from './BlenderRenders';
import { useApp } from '@/state/store';
import OpenDialog from './OpenDialog';
import UnsavedDialog from './UnsavedDialog';
import ConflictDialog from './ConflictDialog';
import NewDialog from './NewDialog';
import CommandPalette from './CommandPalette';
import ShortcutsDialog from './ShortcutsDialog';
import MaterialDialog from './MaterialDialog';
import ToolsDialog from './ToolsDialog';
import BranchDialog from './BranchDialog';
import ImportDialog, { ImportDrop } from './ImportDialog';
import RulesDialog from '@/workspaces/sheetmetal/RulesDialog';
import FormsDialog from '@/workspaces/sheetmetal/FormsDialog';
import StandardPartsDialog from './StandardPartsDialog';
import McMasterDialog from './McMasterDialog';
import BugReportDialog from './BugReportDialog';
import ReportsDialog from './ReportsDialog';
import ShareDialog, { pendingShare } from './ShareDialog';
import CarbonDialog from './CarbonDialog';
import RmfgDialog from './RmfgDialog';
import RunActionDialog from './RunActionDialog';
import { lazy, Suspense, useEffect } from 'react';
import SettingsDialog from '@/settings/SettingsDialog';
import { ConfirmHost } from '@/ui/confirm';
import AutomaticPrompt from '@/connectors/AutomaticPrompt';
import VideoDialog from '@/present/VideoDialog';
import DrawingPreview from '@/drawing/DrawingPreview';

const MergeDialog = lazy(() => import('./merge/MergeDialog'));
const HelpDialog = lazy(() => import('@/help/HelpDialog'));

export default function Dialogs() {
  const dialog = useApp((state) => state.dialog);
  // Back from signing in again to confirm a share: reopen it on the design it was for.
  const resumeShare = useApp((state) => { const pending = pendingShare(); return !!pending && state.doc.saved?.id === pending.document_id; });
  useEffect(() => { if (resumeShare) useApp.setState({ dialog: 'share' }); }, [resumeShare]);
  return (
    <>
      <BlenderRenders open={dialog === 'blender-renders'} />
      <OpenDialog open={dialog === 'open'} />
      <UnsavedDialog open={dialog === 'unsaved'} />
      <ConflictDialog open={dialog === 'conflict'} />
      <NewDialog open={dialog === 'new'} />
      <ImportDialog open={dialog === 'import'} />
      <ImportDrop />
      <OpenDialog open={dialog === 'insert'} mode="link" />
      <CommandPalette open={dialog === 'palette'} />
      <ShortcutsDialog open={dialog === 'shortcuts'} />
      <SettingsDialog open={dialog === 'settings'} />
      <BugReportDialog open={dialog === 'bug'} />
      <ReportsDialog open={dialog === 'reports'} />
      <ShareDialog open={dialog === 'share'} />
      <CarbonDialog open={dialog === 'carbon'} />
      <RmfgDialog open={dialog === 'rmfg'} />
      <RunActionDialog open={dialog === 'runAction'} />
      <MaterialDialog open={dialog === 'material'} />
      <ToolsDialog open={dialog === 'tools'} />
      <BranchDialog open={dialog === 'branch'} />
      <RulesDialog open={dialog === 'sheetRules'} />
      <FormsDialog open={dialog === 'sheetForms'} />
      <StandardPartsDialog open={dialog === 'standardParts'} />
      <McMasterDialog open={dialog === 'mcmaster'} />
      <VideoDialog open={dialog === 'video'} />
      <DrawingPreview />
      {dialog === 'help' && <Suspense fallback={null}><HelpDialog open /></Suspense>}
      <ConfirmHost />
      <AutomaticPrompt />
      {dialog === 'merge' && <Suspense fallback={null}><MergeDialog open /></Suspense>}
    </>
  );
}
