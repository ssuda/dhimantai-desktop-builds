/* Copyright (c) Optficial Labs Pvt Ltd. Licensed under the MIT License. */

import { localize, localize2 } from '../../../../nls.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, setConstant } from '../../../../platform/contextkey/common/contextkey.js';

// The Learning sidebar is Home. Show it at launch, before the learning extension activates.
setConstant('dhimantai.customDesktop', true);

const file = MenuId.for('dhimantai.learningFile');
const edit = MenuId.for('dhimantai.learningEdit');
const view = MenuId.for('dhimantai.learningView');

MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
	submenu: MenuId.for('api:dhimantai.skillingMenu'),
	title: { ...localize2('skilling', "Skilling"), mnemonicTitle: localize('mSkilling', "S&&killing") },
	order: 0,
	when: ContextKeyExpr.has('dhimantai.skillingReady')
});

for (const [menu, id, title, group, order] of [
	[file, 'workbench.action.files.newUntitledFile', localize('newFile', "New File"), '1_open', 1],
	[file, 'workbench.action.files.openFile', localize('openFile', "Open File…"), '1_open', 2],
	[file, 'workbench.action.files.openFolder', localize('openProject', "Open Project Folder…"), '1_open', 3],
	[file, 'workbench.action.files.save', localize('save', "Save"), '2_save', 1],
	[file, 'workbench.action.files.saveAs', localize('saveAs', "Save As…"), '2_save', 2],
	[file, 'workbench.action.closeActiveEditor', localize('closeTab', "Close Tab"), '3_close', 1],
	[edit, 'undo', localize('undo', "Undo"), '1_history', 1],
	[edit, 'redo', localize('redo', "Redo"), '1_history', 2],
	[edit, 'editor.action.clipboardCutAction', localize('cut', "Cut"), '2_clipboard', 1],
	[edit, 'editor.action.clipboardCopyAction', localize('copy', "Copy"), '2_clipboard', 2],
	[edit, 'editor.action.clipboardPasteAction', localize('paste', "Paste"), '2_clipboard', 3],
	[edit, 'editor.action.selectAll', localize('selectAll', "Select All"), '3_selection', 1],
	[view, 'dhimantai.learningNavigation.focus', localize('learning', "Learning Sidebar"), '1_learn', 1],
	[view, 'workbench.action.toggleSidebarVisibility', localize('sidebar', "Toggle Sidebar"), '1_learn', 2],
	[view, 'workbench.action.zoomIn', localize('zoomIn', "Zoom In"), '2_display', 1],
	[view, 'workbench.action.zoomOut', localize('zoomOut', "Zoom Out"), '2_display', 2],
	[view, 'workbench.action.zoomReset', localize('zoomReset', "Reset Zoom"), '2_display', 3],
	[view, 'workbench.action.toggleFullScreen', localize('fullscreen', "Toggle Full Screen"), '2_display', 4],
] as const) {
	MenuRegistry.appendMenuItem(menu, { command: { id, title }, group, order });
}
