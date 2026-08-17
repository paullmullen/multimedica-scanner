"use strict";

// Compatibility entrypoint for existing production service definitions.
// Scanner ownership and QR handling live exclusively in bootstrap/controller.js.
const { createProductionScanServer } = require("./production/scan-server");

if (require.main === module) {
  createProductionScanServer({ logger: console.log }).start();
}

module.exports = require("./production/scan-server");
