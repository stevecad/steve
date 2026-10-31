/**
 * The desktop's side panels, unchanged, in a sheet: the browser (Model, Versions) and the inspector's tabs (Inspector,
 * Source, STEVE, Comments, History, Parts, and a tool's options). They open and close through the app's own
 * browserOpen / dockOpen, so every command, tree row and tool that opens a panel on the desktop opens it here.
 * A tool's options take a lower sheet without a scrim: its picks are on the model above.
 */
import { set, useApp } from '@/state/store';
import ErrorBoundary from '@/ui/ErrorBoundary';
import LeftPanel from '@/shell/LeftPanel';
import Dock from '@/shell/Dock';
import Sheet, { type SheetSize } from './Sheet';

export default function PanelSheet() {
  const browserOpen = useApp((state) => state.browserOpen);
  const dockOpen = useApp((state) => state.dockOpen);
  const dockTab = useApp((state) => state.dockTab);
  const close = () => set({ browserOpen: false, dockOpen: false });
  const size: SheetSize = dockTab === 'tool' ? 'peek' : dockTab === 'assistant' || dockTab === 'source' || dockTab === 'history' ? 'full' : 'half';
  return (
    <>
      <Sheet open={browserOpen} onClose={close} label="Browser" size="half" bare id="phone-browser">
        <ErrorBoundary name="Browser"><LeftPanel /></ErrorBoundary>
      </Sheet>
      <Sheet open={dockOpen && !browserOpen} onClose={close} label="Inspector" size={size} bare id="phone-dock">
        <ErrorBoundary name="Inspector"><Dock /></ErrorBoundary>
      </Sheet>
    </>
  );
}
