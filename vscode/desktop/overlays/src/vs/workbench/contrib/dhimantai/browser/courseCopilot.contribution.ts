/*---------------------------------------------------------------------------------------------
 * Copyright (c) Optficial Labs Pvt Ltd. All rights reserved.
 * Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

// Course selection affects this window only. Never rewrite the learner's user
// settings or a shared workspace file, and never persist a course grant on exit.
CommandsRegistry.registerCommand('_dhimantai.setCourseCopilotEnabled', async (accessor, enabled: unknown) => {
	if (typeof enabled !== 'boolean') {
		throw new Error('Expected a course Copilot boolean');
	}
	const configuration = accessor.get(IConfigurationService);
	if (configuration.inspect<boolean>('chat.disableAIFeatures').memoryValue !== !enabled) {
		await configuration.updateValue('chat.disableAIFeatures', !enabled, ConfigurationTarget.MEMORY);
	}
});
