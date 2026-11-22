/* Copyright (c) Optficial Labs Pvt Ltd. Licensed under the MIT License. */

import './media/skillingWelcome.css';
import { $, append } from '../../../base/browser/dom.js';
import { Button } from '../../../base/browser/ui/button/button.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { defaultButtonStyles } from '../../../platform/theme/browser/defaultStyles.js';

export class SkillingWelcome extends Disposable {
	constructor(container: HTMLElement,
		@ICommandService commands: ICommandService,
		@IConfigurationService configuration: IConfigurationService,
		@IContextKeyService context: IContextKeyService,
		@INotificationService notifications: INotificationService
	) {
		super();
		const wrapper = append(container, $('.editor-group-watermark-wrapper'));
		const content = append(wrapper, $('.editor-group-watermark.dhimantai-welcome'));
		append(content, $('.dhimantai-welcome-mark'));
		append(content, $('h2', undefined, localize('workspace', "Your learning workspace")));
		const action = (label: string, id: string) => {
			const button = this._register(new Button(content, { ...defaultButtonStyles }));
			button.label = label;
			this._register(button.onDidClick(() => { void commands.executeCommand(id).catch(error => notifications.error(error)); }));
			return button;
		};
		const resume = action(localize('resume', "Continue Learning"), 'dhimantai.skilling.resume');
		const browse = action(localize('browse', "Browse Courses"), 'dhimantai.courseCatalog');
		const update = () => {
			wrapper.hidden = !configuration.getValue<boolean>('workbench.tips.enabled');
			const returning = !!context.getContextKeyValue('dhimantai.canResume');
			resume.element.hidden = !returning;
			browse.secondary = returning;
		};
		this._register(context.onDidChangeContext(event => { if (event.affectsSome(new Set(['dhimantai.canResume']))) { update(); } }));
		this._register(configuration.onDidChangeConfiguration(event => { if (event.affectsConfiguration('workbench.tips.enabled')) { update(); } }));
		update();
	}
}
