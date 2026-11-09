/* Copyright (c) Optficial Labs Pvt Ltd. Licensed under the MIT License. */

export const learningExtension = 'optficial.dhimantai-learning';
export type CaptureDevice = 'audio' | 'video';
type Grant = { frame: string; allowed: Set<CaptureDevice>; pending: boolean };

export function mediaOrigin(value: string): string | undefined {
	try {
		const url = new URL(value);
		if (url.protocol === 'vscode-webview:' && /^[a-z0-9]+$/.test(url.host) && !url.username && !url.password) {
			return `${url.protocol}//${url.host}`;
		}
	} catch { /* Reject malformed or remote origins. */ }
	return undefined;
}

/** Registrations come from the trusted workbench, never webview messages or URL parameters. */
export class MediaCapturePolicy {
	private readonly grants = new Map<number, Map<string, Grant>>();
	register(owner: number, frame: string, url: string, extension: string, enabled: boolean): void {
		const origin = mediaOrigin(url);
		if (!origin || extension !== learningExtension) { return; }
		const hosts = this.grants.get(owner) ?? new Map<string, Grant>();
		if (enabled) { hosts.set(origin, { frame, allowed: new Set(), pending: false }); }
		else if (hosts.get(origin)?.frame === frame) { hosts.delete(origin); }
		if (hosts.size) { this.grants.set(owner, hosts); }
		else { this.grants.delete(owner); }
	}
	forget(owner: number): void { this.grants.delete(owner); }
	frame(owner: number, url: string): string | undefined {
		return this.grants.get(owner)?.get(mediaOrigin(url) ?? '')?.frame;
	}
	check(owner: number, url: string, type: string | undefined): boolean {
		if (type !== 'audio' && type !== 'video') { return false; }
		return this.grants.get(owner)?.get(mediaOrigin(url) ?? '')?.allowed.has(type) ?? false;
	}
	async request(owner: number, url: string, types: readonly string[] | undefined,
		prompt: (devices: readonly CaptureDevice[]) => Promise<boolean>, current: () => boolean): Promise<boolean> {
		if (!types?.length || types.some(type => type !== 'audio' && type !== 'video')) { return false; }
		const origin = mediaOrigin(url), grant = this.grants.get(owner)?.get(origin ?? '');
		if (!origin || !grant || grant.pending || !current()) { return false; }
		const devices = [...new Set(types)] as CaptureDevice[];
		if (devices.every(type => grant.allowed.has(type))) { return true; }
		grant.pending = true;
		try {
			const accepted = await prompt(devices);
			if (!accepted || !current() || this.grants.get(owner)?.get(origin) !== grant) { return false; }
			devices.forEach(type => grant.allowed.add(type));
			return true;
		} finally { grant.pending = false; }
	}
}
