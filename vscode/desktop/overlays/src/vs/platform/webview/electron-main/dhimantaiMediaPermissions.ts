/* Copyright (c) Optficial Labs Pvt Ltd. Licensed under the MIT License. */
import { BrowserWindow, dialog, WebContents } from 'electron';
import { MediaCapturePolicy, mediaOrigin } from '../common/dhimantaiMediaPolicy.js';

const policy = new MediaCapturePolicy();
const observed = new WeakSet<WebContents>();

export function registerMediaCapture(contents: WebContents, frame: string, origin: string, extension: string, enabled: boolean): void {
	if (contents.isDestroyed()) { return; }
	policy.register(contents.id, frame, origin, extension, enabled);
	if (!observed.has(contents)) {
		observed.add(contents);
		const owner = contents.id;
		contents.once('destroyed', () => policy.forget(owner));
	}
}

function current(contents: WebContents | null, url: string): contents is WebContents {
	if (!contents || contents.isDestroyed()) { return false; }
	const name = policy.frame(contents.id, url), origin = mediaOrigin(url);
	if (!name || !origin) { return false; }
	try {
		return contents.mainFrame.framesInSubtree.some(frame => !frame.isDestroyed() && !frame.detached
			&& frame.name === name && mediaOrigin(frame.url) === origin);
	} catch { return false; }
}

export function checkMediaCapture(contents: WebContents | null, url: string, type: string | undefined): boolean {
	return current(contents, url) && policy.check(contents.id, url, type);
}

export async function requestMediaCapture(contents: WebContents | null, details: { requestingUrl: string; mediaTypes?: string[] }): Promise<boolean> {
	const url = details.requestingUrl;
	if (!current(contents, url)) { return false; }
	const owner = BrowserWindow.fromWebContents(contents);
	if (!owner || owner.isDestroyed()) { return false; }
	return policy.request(contents.id, url, details.mediaTypes, async devices => {
		const names = devices.map(device => device === 'audio' ? 'microphone' : 'camera').join(' and ');
		const result = await dialog.showMessageBox(owner, {
			type: 'question', title: 'dhimantAI device access',
			message: `Allow this learning notebook to use your ${names}?`,
			detail: 'Access lasts until this notebook closes. Use its device controls to stop sharing. Your operating system may also request permission.',
			buttons: ['Deny', 'Allow'], defaultId: 0, cancelId: 0, noLink: true,
		});
		return result.response === 1;
	}, () => current(contents, url));
}
