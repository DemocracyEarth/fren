/**
 * The barrel overlays append their gateway provider's registration to — one
 * appended `import './x.js';` and one `registerGatewayProvider(...)` call in
 * the imported file, the same shape as the driver barrel (`drivers/installed.ts`)
 * and the provider container-config barrel. Nothing outside this directory is
 * rewritten to install a gateway.
 */
import './onecli.js';

// FREN overlay: the gateway provider FREN Core runs this host with.
import './fren.js';
