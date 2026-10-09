// expect: TS2345
// Code that holds a Link cannot send bytes of its own: send takes an OutReport, and only the egress audit makes one.
import { type Link, asInReport } from "../core/port";

declare const link: Link;
void link.send(new Uint8Array(64));
void link.send(asInReport(new Uint8Array(64)));
