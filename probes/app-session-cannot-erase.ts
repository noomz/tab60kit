// expect: TS2339
// Flash operations exist only on IapSession, so a normal-mode session cannot erase.
import type { AppSession } from "../core/protocol";

declare const session: AppSession;
void session.eraseWindow();
