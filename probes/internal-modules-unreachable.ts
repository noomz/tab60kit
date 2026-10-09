// expect: TS2307
// package.json exports "." and "./port" only, so no file can import a core internal through the package name.
import { COMMANDS } from "@tab60kit/core/protocol";

void COMMANDS;
