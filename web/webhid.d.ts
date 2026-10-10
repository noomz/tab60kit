// The subset of WebHID the shell uses. TypeScript's DOM library does not ship WebHID; the real build takes
// @types/w3c-web-hid instead of this file.

interface HIDDeviceFilter {
	vendorId?: number;
	productId?: number;
	usagePage?: number;
	usage?: number;
}

interface HIDReportItem {
	readonly reportSize: number;
	readonly reportCount: number;
}

interface HIDReportInfo {
	readonly reportId: number;
	readonly items: readonly HIDReportItem[];
}

interface HIDCollectionInfo {
	readonly usagePage: number;
	readonly usage: number;
	readonly inputReports: readonly HIDReportInfo[];
	readonly outputReports: readonly HIDReportInfo[];
	readonly featureReports: readonly HIDReportInfo[];
}

interface HIDInputReportEvent extends Event {
	readonly device: HIDDevice;
	readonly reportId: number;
	readonly data: DataView;
}

interface HIDConnectionEvent extends Event {
	readonly device: HIDDevice;
}

interface HIDDevice extends EventTarget {
	readonly opened: boolean;
	readonly vendorId: number;
	readonly productId: number;
	readonly productName: string;
	readonly collections: readonly HIDCollectionInfo[];
	open(): Promise<void>;
	close(): Promise<void>;
	sendReport(reportId: number, data: BufferSource): Promise<void>;
}

interface HID extends EventTarget {
	getDevices(): Promise<HIDDevice[]>;
	requestDevice(options: { filters: HIDDeviceFilter[] }): Promise<HIDDevice[]>;
}

interface Navigator {
	readonly hid: HID;
}
