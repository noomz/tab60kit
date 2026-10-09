// expect: TS2305
// Neither package entry exports the image-byte accessor or the egress audit, and the UI entry does not export the
// lab clearance constructor. The shell entry exports only the Clearance type, which cannot be built as a literal
// (lab-clearance-needs-constructor.ts). probes/boundaries.ts keeps web/ from importing core internals directly.
import { auditEgress, imageBytes, labClearance } from "../core/index";
import { auditEgress as audit, imageBytes as bytes } from "../core/port";

void [auditEgress, imageBytes, labClearance, audit, bytes];
