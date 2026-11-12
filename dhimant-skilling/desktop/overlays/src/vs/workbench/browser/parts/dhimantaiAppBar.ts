/*---------------------------------------------------------------------------------------------
 * Copyright (c) Optficial Labs Pvt Ltd. All rights reserved.
 * Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import './media/dhimantaiAppBar.css';
import { $, addDisposableListener, append, EventType } from '../../../base/browser/dom.js';
import { IAction, toAction } from '../../../base/common/actions.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IColorTheme } from '../../../platform/theme/common/themeService.js';
import { IActivityHoverOptions, ICompositeBarColors } from './compositeBarActions.js';

interface AppBarState { status: string; message: string; profile: string; initials: string }
let state: AppBarState = {
	status: 'unchecked', message: localize('updates', "Updates"),
	profile: localize('profile', "Your dhimantAI profile"), initials: ''
};
const changes = new Emitter<void>();
CommandsRegistry.registerCommand('_dhimantai.setAppBarState', (_accessor, value: unknown) => {
	const next = value as Partial<AppBarState> | undefined;
	if (!next || !['unchecked', 'checking', 'current', 'available', 'downloading', 'ready', 'unavailable'].includes(next.status ?? '')
		|| typeof next.message !== 'string' || typeof next.profile !== 'string' || typeof next.initials !== 'string') {
		throw new Error('Invalid app bar state');
	}
	state = { status: next.status!, message: next.message.slice(0, 240), profile: next.profile.slice(0, 240), initials: next.initials.slice(0, 2) };
	changes.fire();
});

/** Uses the existing activity-bar layout and focus boundary; no additional rail. */
export class DhimantaiAppBar extends Disposable {
	readonly element = $('.dhimantai-app-controls');
	private readonly updateButton: HTMLButtonElement;
	private readonly profileButton: HTMLButtonElement;
	private readonly updateIcon: HTMLElement;
	private readonly avatar: HTMLElement;
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	constructor(
		_contextActions: () => IAction[],
		_colors: (theme: IColorTheme) => ICompositeBarColors,
		_hover: IActivityHoverOptions,
		@ICommandService private readonly commands: ICommandService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.element.setAttribute('role', 'group');
		this.element.setAttribute('aria-label', localize('appControls', "App updates and profile"));
		this.updateButton = this.button('dhimantai.showUpdates');
		this.updateButton.classList.add('dhimantai-update');
		this.updateIcon = append(this.updateButton, $('span.codicon.codicon-cloud-download'));
		this.updateIcon.setAttribute('aria-hidden', 'true');
		this.profileButton = this.button('dhimantai.profile');
		this.avatar = append(this.profileButton, $('span.dhimantai-avatar'));
		this.avatar.setAttribute('aria-hidden', 'true');
		this._register(changes.event(() => this.render()));
		this.render();
		this._register(addDisposableListener(this.element, EventType.KEY_DOWN, event => {
			if (event.key === 'ArrowDown' && event.target === this.updateButton) {
				event.preventDefault(); event.stopImmediatePropagation(); this.profileButton.focus();
			} else if (event.key === 'ArrowUp' && event.target === this.profileButton) {
				event.preventDefault(); event.stopImmediatePropagation(); this.updateButton.focus();
			}
		}));
	}
	private button(command: string): HTMLButtonElement {
		const button = append(this.element, $('button')) as HTMLButtonElement;
		button.type = 'button';
		button.setAttribute('aria-haspopup', 'dialog');
		this._register(addDisposableListener(button, EventType.CLICK, () => {
			void this.commands.executeCommand(command).catch(error => this.notifications.error(error));
		}));
		return button;
	}
	private render(): void {
		this.updateButton.title = state.message;
		this.updateButton.setAttribute('aria-label', state.message);
		this.updateButton.dataset.status = state.status;
		const busy = state.status === 'checking' || state.status === 'downloading';
		this.updateIcon.className = `codicon codicon-${busy ? 'sync codicon-modifier-spin' : state.status === 'ready' ? 'check' : 'cloud-download'}`;
		this.profileButton.title = state.profile;
		this.profileButton.setAttribute('aria-label', state.profile);
		this.avatar.className = state.initials ? 'dhimantai-avatar signed-in' : 'dhimantai-avatar codicon codicon-account';
		this.avatar.textContent = state.initials;
	}
	create(parent: HTMLElement): void { parent.appendChild(this.element); }
	focus(): void { this.updateButton.focus(); }
	getHeight(actionHeight: number, actionGap: number): number {
		this.element.style.setProperty('--dhimantai-action-height', `${actionHeight}px`);
		this.element.style.gap = `${actionGap}px`;
		return actionHeight * 2 + actionGap;
	}
	getContextMenuActions(): IAction[] {
		return [toAction({ id: 'dhimantai.settings', label: localize('settings', "Settings"), run: () => this.commands.executeCommand('workbench.action.openSettings') })];
	}
}
