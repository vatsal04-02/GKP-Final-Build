// The existing module tests (W1, W3, W4, W5, W6, W11, W12: 25 simulated scenarios from n8n/merged/merged.flow.test.js) run
// unchanged against the INTEGRATED master: integrating the AI receptionist did not change how the other modules behave.
// Run: node n8n/integrated/existing-modules.test.js
const path = require('path');
process.env.MERGED_FILE = process.env.INTEGRATED_FILE || path.join(__dirname, 'clinic-autopilot-master-ai.stage1.json');
require('../merged/merged.flow.test.js');
