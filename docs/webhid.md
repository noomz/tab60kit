# WebHID notes

Code comments in this repository cite facts by short IDs such as `C12` or `D4`. This page holds those facts. Each one has a label. VERIFIED means someone read it in a primary source. INFERRED means it follows from verified facts. GUESS means it is plausible but unsupported.

## Why the tool is a web page

tab60kit is a WebHID page on a TypeScript core. It runs in Chrome or Edge on macOS, Linux and Windows, with nothing to install. A page ships updates on reload, needs no code signing, and the same core code runs in Node for tests. The cost is a chooser pick each time the board changes mode, because the board has no USB serial number and its bootloader uses another product ID. Safari and Firefox have no WebHID. Electron, a Rust CLI or a Node CLI could reuse the core later through the `Transport` seam, which hands the core a fresh transport after every mode switch. Swift was rejected because it cannot run on Linux.

Chromium source links below use this base, a Chromium main snapshot from 2026-10-09: `https://chromium.googlesource.com/chromium/src/+/8a122b2001583d901cea023c738bffc4e2aa48a3/`. It is written `CR/` in the lists.

## Browsers

### B1. Which browsers have WebHID
- WebHID is in Chrome 89 and later. Edge and Opera follow Chrome. Firefox, Safari and Chrome for Android have none. Label: VERIFIED.
- Source: https://github.com/mdn/browser-compat-data/blob/a9a88bb2f33cc3140b584c3e8bea72903e07c835/api/HID.json
- WebHID is a Community Group draft, and only Chromium ships it.

### B2. Safari and Firefox will not ship it soon
- WebKit's standards position on WebHID is "oppose". Mozilla's is "negative". Label: VERIFIED.
- Sources: https://github.com/WebKit/standards-positions and https://github.com/mozilla/standards-positions (look up "WebHID").
- Brave is a separate case. Its wallet talks to Ledger over WebHID, and users report VIA working there, so desktop Brave ships WebHID. Label: INFERRED (https://github.com/brave/brave-browser/issues/16206). Arc was not checked (GUESS).

## Chromium WebHID behavior

### C1. A grant lasts only while the board stays connected
- Chrome keeps a persistent grant only if the device has a serial number and a product name. Otherwise the grant is ephemeral and keyed by a connection GUID. The TAB 60 has no serial number (see D2 below), so its grant is ephemeral. Label: VERIFIED.
- Source: CR/chrome/browser/hid/hid_chooser_context.cc, lines 153-155, 175-178, 430-435.
- On removal, Chrome notifies observers first and then revokes the ephemeral grant (lines 669-702). So `disconnect` still fires for the old device. Label: VERIFIED order, INFERRED event.
- Chromium mints a new random GUID each time it enumerates an interface (CR/services/device/hid/hid_device_info.cc, lines 70 and 112). Label: VERIFIED.

### C3. A new product ID matches no old grant
- The permission check runs in this order: blocklist, policy, guard setting, ephemeral GUID, then persistent vendor, product and serial match. A bootloader with PID 0x1304 matches nothing granted to PID 0x0304. Label: VERIFIED.
- Source: CR/chrome/browser/hid/hid_chooser_context.cc, lines 500-560.
- After a reset of this board, `connect` never fires unless a policy grants the device (C13 below). Label: INFERRED from C1, C3 and D2.
- `connect` and `getDevices()` deliver a device only when the page already has permission for it. Label: VERIFIED (CR/content/browser/hid/hid_service.cc, lines 582-601 and 708-731).

### C5. One click opens one chooser
- `requestDevice` needs transient user activation, and the browser consumes it. One click opens one chooser. Activation lasts 5 seconds. Label: VERIFIED.
- Sources: CR/third_party/blink/renderer/modules/hid/hid.cc, lines 319-321; CR/content/browser/hid/hid_service.cc, lines 451-462; CR/third_party/blink/public/common/frame/user_activation_state.h, lines 15-24.
- `open`, `sendReport` and the feature calls need no activation. Label: VERIFIED by absence (no mention of activation in `hid_device.cc`).
- So the page asks for the bootloader chooser in the same click handler that sends the reset command.

### C7. The chooser keeps watching
- The chooser keeps listening after its first enumeration. It adds a row when a matching device appears. A page can open the bootloader chooser first and send the reset second. Label: VERIFIED code path.
- Source: CR/chrome/browser/ui/hid/hid_chooser_controller.cc, lines 235-245 and 289-302.
- If the row does not appear, the page falls back to a parked **Connect bootloader** pick after the reset. That costs one more click.

### C8. A pick grants only the interfaces that pass the filters
- Chooser rows group interfaces by physical device, but a row holds only the interfaces that pass the filters. `Select` grants only the row's devices. Label: VERIFIED.
- Source: CR/chrome/browser/ui/hid/hid_chooser_controller.cc, lines 30-39, 174-192, 292, 346 and 382-394.
- Filter on usage page 0xFF00 so the keyboard interfaces stay out of the grant. A filter with only vendor and product ID would grant every interface.
- One filter list may name both PIDs.

### C12. A stale HIDDevice can hang
- After an unexpected disconnect, the old `HIDDevice` can still report `opened`. Calls on it may be dropped silently. Chromium adds no HID timeouts. Label: INFERRED from verified code.
- The shell therefore takes a new `HIDDevice` after every reset, and races each call against a page timer (see E2).

### C14. DevTools cannot drive the WebHID chooser
- The DevTools device-prompt hook is wired into the Web Bluetooth chooser only. The HID chooser, delegate and service have no DevTools reference. Puppeteer's device-prompt API cannot drive the WebHID chooser. Label: VERIFIED absence, INFERRED consequence.
- Sources: CR/content/browser/bluetooth/bluetooth_device_chooser_controller.cc, lines 260 and 372; no match in `hid_chooser_controller.cc`, `chrome_hid_delegate.cc` or `hid_service.cc`.
- A click sent by browser automation also left `requestDevice()` pending with no visible chooser on macOS. A real click worked.

### Other Chromium facts the code relies on
- Protected reports cover the keyboard page, Generic Desktop pointer, mouse, keyboard and keypad, and the system-control ranges. Vendor page 0xFF00 and consumer 0x0C are not protected. The static blocklist has no 0x04D9 entry. A remote setting could add one at runtime (GUESS, low risk). Label: VERIFIED rules (CR/services/device/public/cpp/hid/hid_report_utils.cc, lines 36-63; hid_blocklist.cc, lines 37-111 and 232-237).
- A discarded tab is possible: discard eligibility protects visible and active tabs and has no HID rule. Keep the flashing tab in front. Label: VERIFIED (CR/chrome/browser/performance_manager/policies/discard_eligibility_policy.cc, lines 144-145, 276 and 396-407).
- Policy `WebHidAllowDevicesForUrls` grants listed origins access by vendor ID and optional product ID. It is checked before ephemeral grants. Label: VERIFIED. Needing a configuration profile on macOS is INFERRED.
- `HIDDevice` exposes `productId` and `productName` and no serial number. Label: VERIFIED (CR/third_party/blink/renderer/modules/hid/hid_device.idl, lines 24-27).
- `chrome://device-log` at Debug level records open failures and the Base64 report descriptor of each interface.

## Devices

### D4. Sibling bootloaders look like the TAB 60 app interface
- Five sibling bootloader dumps (Cypher PID 0x1282, RACE3 0x1192, MD200 0x1200, POK3R RGB2 0x1207, KBP V60 0x1112) each have three HID interfaces. Interface 1 is class 3 with two interrupt endpoints. It has the same 34-byte vendor report descriptor as the TAB 60 app: usage page 0xFF00, usage 0x01, 64-byte input and output reports, no report ID. Each has `iSerialNumber` 0 and the product string "USB-HID IAP". Label: VERIFIED (parsed from the dumps).
- Source: https://github.com/pok3r-custom/pok3r_re_firmware/tree/2fd4073aeefe713ef769b93b077aa67090a0b620/disassemble
- Nobody has seen the TAB 60 bootloader enumerate with PID 0x1304 on its own. That value is VERIFIED as a package field and as pok3rtool's rule (set bit 0x1000 on the app PID). For this unit it is INFERRED.
- The app interface itself (D1): usage page 0xFF00, usage 0x01, report ID 0, 64-byte input and output reports, no feature reports. Label: VERIFIED on macOS in Chrome 154.
- The app-mode device descriptor has no serial string (D2) and the product string is "USB-HID Keyboard". Label: VERIFIED.

### D5. The vendor updater flashes through the plain Windows HID stack
- The official updater imports `HID.DLL` (eight functions, including `HidD_GetHidGuid`, `HidD_GetAttributes`, `HidP_GetCaps`), `SETUPAPI.dll`, and `CreateFile`, `ReadFile`, `WriteFile`. It has no WinUSB, libusb, newdev or DIFx string, and no `.inf` or `.sys` name. Label: VERIFIED imports (updater sha256 `fc7ee18829eaccb2c3d56d76af0e24f739d7bbf8640221790fb9d39d716849dd`, import directory RVA 0x1789c4).
- So the bootloader it flashes is a HID device on the in-box driver, and needs no driver install. Label: INFERRED.
- One SETUPAPI import, `CMP_WaitNoPendingInstallEvents`, waits for Windows to finish setting up a new device. That fits a reset into a new PID.
- Flash commands: `0x11/0x00` resets to the bootloader, `0x11/0x01` back to the app. Erase, write, SUM and CRC run only in the bootloader. Label: VERIFIED (from pok3rtool). Writing the version block last keeps an interrupted flash recoverable. Label: INFERRED.

## Errors and timeouts

### E2. Chromium adds no HID timeouts
- Chromium puts no timeout on `open`, `sendReport` or `receiveFeatureReport`. A call on a stale handle may never settle (C12). Label: VERIFIED code reading, INFERRED consequence.
- So `web/webhid-port.ts` races every call against a page timer.
- A permission failure on Linux shows up differently. The chooser lists the device, then `open()` rejects with `NotAllowedError`, and device-log shows `FILE_ERROR_ACCESS_DENIED`. Label: VERIFIED.
- Send all 64 bytes of a packet with `sendReport(0, packet)`. Chromium adds the report ID byte, then drops it again on macOS and Linux. Windows pads short reports, macOS and Linux send them short. Label: VERIFIED mechanics, INFERRED full-length rule.
- Replies arrive as `inputreport` events with `reportId` 0 and 64 data bytes. Label: VERIFIED.

## Native shell notes

These matter only if a shell other than the page reuses the core.

### O3. hidapi seizes the device on macOS
- hidapi opens devices exclusively on macOS by default. A tool that seizes interface 1 locks Chrome out. The Rust `hidapi` crate has a `macos-shared-device` feature, and `async-hid` opens shared. Chrome itself opens devices in shared mode. Label: VERIFIED.
- Karabiner-Elements matches keyboard, mouse, pointer, joystick, gamepad and consumer usages, not vendor pages (VERIFIED).
- macOS asks for Input Monitoring only for a device that conforms to a Generic Desktop keyboard or mouse or a touchpad. Interface 1 has no such collection. Label: VERIFIED (https://github.com/apple-oss-distributions/IOHIDFamily/blob/main/IOHIDFamily/IOHIDDevice.cpp, lines 527-531).

### O9. Windows locks keyboard collections, not vendor ones
- Windows opens keyboard and mouse collections exclusively. Vendor pages have no in-box client and open read-write. Label: VERIFIED docs, INFERRED for the TAB 60.
- Linux: hidraw nodes are root-owned with mode 0600 and no `uaccess` tag for keyboards, so Chrome lists the device but cannot open it. The snap build of Chromium cannot open hidraw. Use Google Chrome's deb or rpm package. Label: VERIFIED defaults, INFERRED net effect. Flatpak Chrome should work with the host rule, but hotplug there is a GUESS.

### N10. node-hid for a Node shell
- node-hid 3.4.0 is N-API with prebuilds for macOS, Linux and Windows. The Linux hidraw prebuild needs `libudev.so.1` and `libusb-1.0.so.0`. Label: VERIFIED.
- Stream Deck, X-keys and Ledger split their packages the same way: a core, a node-hid adapter and a WebHID adapter. Label: VERIFIED.

### T1. A uhid device passes hidapi's hidraw test on CI
- A uhid device with a 0xFF00 descriptor passes hidapi's hidraw test on GitHub-hosted ubuntu-24.04. Label: VERIFIED.

### T2. Chrome on Linux sees uhid-backed hidraw nodes
- Chrome on Linux enumerates uhid-backed hidraw nodes. Label: VERIFIED in code, INFERRED end to end. No WebHID project was found that tests this way in CI.

### T3. uhid can fake the bootloader switch
- uhid can destroy a device and create it again with another PID. That simulates the switch from PID 0x0304 to 0x1304. Label: VERIFIED mechanism, INFERRED use.
- Hosted macOS runners cannot create a virtual HID device, because Apple requires an entitlement and a TCC grant. macOS stays a manual test. Label: VERIFIED.

## Linux udev rule

Chrome needs permission to open the vendor interface in both modes. This rule gives the logged-in user access to interface 1 only, for PID 0x0304 (app) and 0x1304 (bootloader):

```
SUBSYSTEM=="hidraw", ENV{ID_VENDOR_ID}=="04d9", ENV{ID_MODEL_ID}=="0304", ENV{ID_USB_INTERFACE_NUM}=="01", TAG+="uaccess"
SUBSYSTEM=="hidraw", ENV{ID_VENDOR_ID}=="04d9", ENV{ID_MODEL_ID}=="1304", ENV{ID_USB_INTERFACE_NUM}=="01", TAG+="uaccess"
```

Save it as `/etc/udev/rules.d/70-vortex-tab60.rules` (the name must sort before `73-`), run `sudo udevadm control --reload`, and replug the board.
