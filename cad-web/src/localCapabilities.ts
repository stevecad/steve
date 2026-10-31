/** Hosted Studio services are not part of the local CAD application. */
export const HOSTED_SERVICES = false;
/** Document commands can cross workspace categories, so disable these explicitly. */
export const NON_CAD_COMMANDS = new Set([
  'shop.link', 'design.linkCircuit', 'doc.new.circuit',
]);
export const HOSTED_COMMANDS = new Set([
  // Studio document branches require its branch API. Local revision history
  // and repository Git operations remain available through their own controls.
  'branch.new', 'branch.merge',
  'doc.share', 'doc.carbon', 'doc.rmfg', 'doc.rmfgOrders', 'app.runAction',
  'app.reportBug', 'app.requestFeature', 'app.myReports', 'app.whatsNew',
]);
