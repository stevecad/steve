/** Library kinds as the UI names and groups them (the backend defines the kinds themselves). */
import { Boxes, Cpu, Diamond, FileCode, Gauge, Layers, Printer, Settings2, SquareStack, Wrench } from 'lucide-react';
import type { Kind } from './api';

export const KIND_LABELS: Record<Kind, { one: string; many: string; icon: typeof Cpu }> = {
  machine_instance: { one: 'Machine', many: 'Machines', icon: Cpu },
  machine_model: { one: 'Model', many: 'Models', icon: Boxes },
  controller: { one: 'Controller', many: 'Controllers', icon: Settings2 },
  rotary_cutter: { one: 'Cutter', many: 'Cutters', icon: Wrench },
  tool_holder: { one: 'Holder', many: 'Holders', icon: Wrench },
  tool_assembly: { one: 'Tool assembly', many: 'Tool assemblies', icon: Wrench },
  tool_setup: { one: 'Tool setup', many: 'Tool setups', icon: Layers },
  fff_profile: { one: 'Print profile', many: 'Print profiles', icon: Printer },
  post_processor: { one: 'Post', many: 'Posts', icon: FileCode },
  machining_material: { one: 'Material', many: 'Materials', icon: SquareStack },
  cutting_preset: { one: 'Cutting preset', many: 'Cutting presets', icon: Gauge },
  turning_tool_setup: { one: 'Lathe tool setup', many: 'Lathe tool setups', icon: Layers },
  turning_assembly: { one: 'Turning tool', many: 'Turning tools', icon: Wrench },
  turning_insert: { one: 'Turning insert', many: 'Turning inserts', icon: Diamond },
  turning_holder: { one: 'Turning holder', many: 'Turning holders', icon: Wrench },
};

/** A record's label, also for a kind the backend added after this build (shown by its own name, never a crash). */
export const kindLabel = (kind: string) => (KIND_LABELS as Record<string, (typeof KIND_LABELS)[Kind] | undefined>)[kind]
  ?? { one: kind.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), many: kind.replace(/_/g, ' '), icon: Boxes };

export const GROUPS: { title: string; kinds: Kind[] }[] = [
  // A machine is a model with a controller fitted. Controllers are a list of their own (a model can come with several,
  // and a shop can own several); a machine's model is picked and defined in the Machine form (machine/MachineFields.tsx).
  { title: 'Machines', kinds: ['machine_instance', 'controller'] },
  { title: 'Tools', kinds: ['tool_setup', 'tool_assembly', 'rotary_cutter', 'tool_holder'] },
  // Lathe tools: an insert clamped in a holder (docs/MANUFACTURING_TURNING_TOOLS.md), loaded into a lathe's stations
  // by a lathe tool setup (docs/MANUFACTURING_TURNING_ASSIGNMENTS.md).
  { title: 'Turning tools', kinds: ['turning_tool_setup', 'turning_assembly', 'turning_insert', 'turning_holder'] },
  // Feeds and speeds: the limits a cutter may run at in a stock material (docs/MANUFACTURING_CUTTING_PRESETS.md).
  { title: 'Cutting data', kinds: ['cutting_preset', 'machining_material'] },
  { title: 'Processes', kinds: ['post_processor'] },
];
