/**
 * A new circuit: an empty board, already set up for the fab house (docs/ELECTRONICS.md, "Readiness"): 1.6 mm, pad
 * clearance and standard vias. Parts come from the person (Place, Shift+A) or from STEVE; nothing is made up for them.
 */
export const CIRCUIT_TEMPLATE = `export default () => (
  <board width="30mm" height="20mm" thickness="1.6mm" minTraceToPadEdgeClearance="0.15mm" pcbStyle={{ viaHoleDiameter: "0.3mm", viaPadDiameter: "0.6mm" }}>
  </board>
)
`;

/**
 * A starter circuit to learn from, offered in Source's menu: a voltage divider with its filter capacitor and a header. It
 * builds clean, autoroutes on two layers and is ready to order as it stands (fab-ready board, a 0.4 mm ground net, in-stock
 * JLCPCB basic parts pinned in array form). Its schematic is placed by hand (schX/schY) the way the electronics-schematic
 * skill asks: input at the top, ground at the bottom, signal left to right. It divides a signal (an ADC input, say), so
 * its nets are IN and OUT: tscircuit draws any net named V… as a supply rail, and the checks treat a V… net from a header
 * as a power input that needs a fuse and reverse-polarity protection.
 */
export const DIVIDER_EXAMPLE = `export default () => (
  <board width="30mm" height="20mm" thickness="1.6mm" minTraceToPadEdgeClearance="0.15mm" pcbStyle={{ viaHoleDiameter: "0.3mm", viaPadDiameter: "0.6mm", silkscreenFontSize: "1mm" }}
    schMaxTraceDistance={3}>
    <net name="GND" nominalTraceWidth="0.4mm" />
    <pinheader name="J1" pinCount={3} pitch="2.54mm" pinLabels={["IN", "OUT", "GND"]} footprint="jlcpcb:C7430359" supplierPartNumbers={{ jlcpcb: ["C7430359"] }}
      pcbX={-10} pcbY={0} schX={-3} schY={-0.1} connections={{ IN: "net.IN", OUT: "net.OUT", GND: "net.GND" }} />
    <resistor name="R1" resistance="10k" footprint="jlcpcb:C25804" supplierPartNumbers={{ jlcpcb: ["C25804"] }} pcbX={2} pcbY={4} schX={0} schY={0.8} schRotation={270}
      connections={{ pin1: "net.IN", pin2: "net.OUT" }} />
    <resistor name="R2" resistance="10k" footprint="jlcpcb:C25804" supplierPartNumbers={{ jlcpcb: ["C25804"] }} pcbX={2} pcbY={-4} schX={0} schY={-0.8} schRotation={270}
      connections={{ pin1: "net.OUT", pin2: "net.GND" }} />
    <capacitor name="C1" capacitance="100nF" footprint="jlcpcb:C14663" supplierPartNumbers={{ jlcpcb: ["C14663"] }} pcbX={8} pcbY={0} schX={1.4} schY={-0.8} schRotation={270}
      connections={{ pin1: "net.OUT", pin2: "net.GND" }} />
  </board>
)
`;
