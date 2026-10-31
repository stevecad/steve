// Steve-owned example, ABI steve_javascript_v1. One preloaded tool, linear XYZ.
// This is a translation adapter, not a collision checker or machine qualification.
function post(input, output) {
  const c = input.controller, m = input.motion;
  if (input.kind !== 'cartesian_3axis_linear_v1' || c.dialect !== 'linuxcnc_cartesian_linear_v1')
    throw new Error('Unsupported post input');
  const n = value => output.format(value, c.output_decimal_places);
  for (const key of ['length_offset_mm','tool_diameter_mm']) {
    if (Number(n(c[key])) !== c[key]) throw new Error('Tool table precision loss');
  }
  if (m.spindle_rpm > c.maximum_spindle_rpm || Number(n(m.spindle_rpm)) <= 0)
    throw new Error('Invalid spindle speed');
  if (m.moves[m.moves.length-1].end_mm[2] < c.retract_tip_z_mm) throw new Error('Missing final retract');
  const file = output.file('program.nc');
  let sequence = input.properties.sequence_start;
  const line = text => {
    file.writeLine(input.properties.sequence_numbers ? 'N'+sequence+' '+text : text);
    sequence += 10;
  };
  const wcs = ['G54','G55','G56','G57','G58','G59','G59.1','G59.2','G59.3'][c.work_offset-1];
  if (!wcs) throw new Error('Unsupported work offset');
  ['G21','G90','G17','G94','G40','G49','G80','G92.1',wcs,'G61.1','M5','M9',
    'G43 H'+(c.length_register ?? c.tool_number),'S'+n(m.spindle_rpm),m.spindle_direction==='cw'?'M3':'M4'].forEach(line);
  for (const move of m.moves) {
    const point = move.end_mm.map((v,i) => v-c.work_origin_mm[i]);
    point[2] += c.tool_gauge_length_mm-c.length_offset_mm;
    let block = (move.kind==='rapid'?'G0':'G1')+' '+point.map((v,i) => 'XYZ'[i]+n(v)).join(' ');
    if (move.kind === 'feed') {
      if (move.feed_mm_min > c.maximum_feed_mm_min || Number(n(move.feed_mm_min)) <= 0)
        throw new Error('Invalid feed');
      block += ' F'+n(move.feed_mm_min);
    }
    line(block);
  }
  ['M9','M5','G49','M2'].forEach(line);
  const register = c.length_register ?? c.tool_number;
  output.file('tool.tbl','tool_table').writeLine(
    'T'+register+' P'+register+' Z'+n(c.length_offset_mm)+' D'+n(c.tool_diameter_mm));
}
