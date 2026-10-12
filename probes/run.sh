#!/bin/bash
# Each probe injects one defect the design claims the compiler rejects, and names the error it predicts.
# A probe passes only when tsc fails on that probe file with exactly the predicted code.
# The control must compile, and the mutation check edits a copy of the sketch and expects the screen switch to break.
# Then probes/boundaries.ts checks the import and egress rules the compiler cannot see, on this tree and on copies
# that each break one rule.
# Usage: probes/run.sh   (TSC=/path/to/tsc and BUN=/path/to/bun to override; needs TypeScript 5.x and Bun, no packages)
set -u
cd "$(dirname "$0")/.."
TSC="${TSC:-tsc}"
OPTS=(--noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM
	--exactOptionalPropertyTypes --noUncheckedIndexedAccess --verbatimModuleSyntax --isolatedModules --skipLibCheck)
fails=0

for probe in probes/*.ts; do
	expect=$(sed -n 's#^// expect: ##p' "$probe" | head -1)
	[ -z "$expect" ] && continue
	out=$("$TSC" "${OPTS[@]}" web/webhid.d.ts "$probe" 2>&1)
	status=$?
	if [ "$expect" = "none" ]; then
		if [ $status -eq 0 ]; then echo "PASS $probe compiles"; else echo "FAIL $probe should compile:"; echo "$out"; fails=$((fails+1)); fi
		continue
	fi
	hit=$(printf '%s\n' "$out" | grep -E "^${probe}\([0-9]+,[0-9]+\): error ${expect}:" | head -1)
	other=$(printf '%s\n' "$out" | grep -E "error TS[0-9]+" | grep -vE "^${probe}\([0-9]+,[0-9]+\): error ${expect}:" | head -1)
	if [ $status -ne 0 ] && [ -n "$hit" ] && [ -z "$other" ]; then
		echo "PASS $probe rejected: ${hit#*error }"
	else
		echo "FAIL $probe expected only $expect in the probe file, got:"; echo "$out"; fails=$((fails+1))
	fi
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp -R core web package.json "$work/"
perl -0pi -e 's/(export type JobState =\n)/$1\t| { readonly kind: "paused"; readonly board: ChipState | null }\n/' "$work/core/job.ts"
grep -q '"paused"' "$work/core/job.ts" || { echo "FAIL mutation did not apply"; exit 1; }
out=$("$TSC" "${OPTS[@]}" "$work/web/webhid.d.ts" "$work/web/screens.ts" 2>&1)
if printf '%s\n' "$out" | grep -qE "screens\.ts\([0-9]+,[0-9]+\): error TS2322: Type '\{ readonly kind: \"paused\";"; then
	echo "PASS a new JobState variant without a screen fails to compile: $(printf '%s\n' "$out" | grep -E 'screens\.ts' | head -1 | sed 's#.*error ##')"
else
	echo "FAIL adding a JobState variant did not break screens.ts:"; echo "$out"; fails=$((fails+1))
fi

BUN="${BUN:-bun}"
"$BUN" probes/boundaries.ts .
fails=$((fails+$?))

lint_mutation() {
	local why=$1 rule=$2 file=$3 line=$4 copy
	copy=$(mktemp -d)
	cp -R core web testing lab tools package.json "$copy/"
	printf '%s\n' "$line" >> "$copy/$file"
	if "$BUN" probes/boundaries.ts "$copy" | grep -q "^FAIL $rule:"; then
		echo "PASS $rule catches $why"
	else
		echo "FAIL $rule missed $why"; fails=$((fails+1))
	fi
	rm -rf "$copy"
}
lint_mutation "a fake board that imports the host codec" fake-board-independence testing/fake-tab60.ts 'import { xorWords } from "../core/firmware";'
lint_mutation "a fake board that imports the core by package name" fake-board-independence testing/fake-tab60.ts 'import { createKit } from "@tab60kit/core";'
lint_mutation "a verdict that borrows the host codec" u1-checks-independence lab/u1-checks.ts 'import { auditEgress } from "../core/protocol"; void auditEgress;'
lint_mutation "a frame allowlist that borrows the host codec" u1-frames-independence lab/u1-frames.ts 'import { auditEgress } from "../core/protocol"; void auditEgress;'
lint_mutation "UI code that imports a core internal" web-entries web/screens.ts 'import type { CommandName } from "../core/protocol";'
lint_mutation "UI code that imports the shell entry" web-entries web/screens.ts 'import type { Link } from "@tab60kit/core/port";'
lint_mutation "a cast to OutReport outside the audit" one-egress web/webhid-port.ts 'export const forged = new Uint8Array(64) as OutReport;'
lint_mutation "a sendReport call outside the WebHID link" one-egress lab/u1.ts 'export const raw = (device: HIDDevice) => device.sendReport(0, new Uint8Array(64));'
lint_mutation "shipped page code that takes the lab port" lab-port web/main.ts 'import { startWebHidLab } from "./webhid-port"; void startWebHidLab;'

# docs/units.md U4: the property test must notice a window check that lets one page past the end through.
copy=$(mktemp -d)
cp -R core testing package.json "$copy/"
perl -0pi -e 's/(offset \+ length <= window\.end - window\.base)/$1 + window.pageSize/' "$copy/core/flashmap.ts"
grep -q 'window\.base + window\.pageSize' "$copy/core/flashmap.ts" || { echo "FAIL mutation did not apply"; exit 1; }
out=$(cd "$copy" && "$BUN" test testing/egress-property.test.ts 2>&1)
status=$?
if [ $status -ne 0 ] && printf '%s\n' "$out" | grep -q "the audit passed a frame that addresses outside the window"; then
	echo "PASS the property test catches an inWindow that accepts one page past the end"
else
	echo "FAIL the property test missed an inWindow that accepts one page past the end:"; echo "$out" | tail -20; fails=$((fails+1))
fi
rm -rf "$copy"

echo "failures: $fails"
exit $fails
