#!/usr/bin/env python3
"""Apply reviewed desktop changes after VSCodium's pinned preparation step."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import shutil
import re

ROOT = Path(__file__).resolve().parent


def refresh_webview_csp(path):
    source = path.read_text()
    scripts = re.findall(r'<script async type="module">([\s\S]*?)</script>', source)
    if len(scripts) != 1:
        raise RuntimeError('Webview preload script structure changed')
    digest = base64.b64encode(hashlib.sha256(scripts[0].encode()).digest()).decode()
    source, count = re.subn(r"script-src 'sha256-[^']+'", "script-src 'sha256-" + digest + "'", source)
    if count != 1:
        raise RuntimeError('Webview preload CSP structure changed')
    path.write_text(source, newline='\n')


def replace(root, name, before, after):
    path = root / name
    source = path.read_text()
    if source.count(before) != 1:
        raise RuntimeError(f'Upstream changed or already customized: {name}: {before[:70]!r}')
    path.write_text(source.replace(before, after))


def customize(root):
    lock = json.loads((ROOT / 'lock.json').read_text())
    if f'target="{lock["electronVersion"]}"' not in (root / '.npmrc').read_text():
        raise RuntimeError('Untested Electron version')
    customize_navigation(root)
    customize_appearance(root)
    configure_brand(root)
    configure_app_bar(root)
    configure_skilling_shell(root)
    # The catalog or chapter click starts the lesson. Its WebRTC audio element
    # attaches later, after the grant and agent handoff, often in a new webview.
    replace(root, 'src/vs/platform/windows/electron-main/windows.ts',
        "autoplayPolicy: 'user-gesture-required'", "autoplayPolicy: 'document-user-activation-required'")
    configure_course_copilot(root)
    configure_learning_updates(root)
    preserve_updated_profile_extensions(root)
    for source in (ROOT / 'overlays').rglob('*'):
        if not source.is_file():
            continue
        target = root / source.relative_to(ROOT / 'overlays')
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    app = 'src/vs/code/electron-main/app.ts'
    replace(root, app, "import { WebviewMainService }", "import { checkMediaCapture, requestMediaCapture } from '../../platform/webview/electron-main/dhimantaiMediaPermissions.js';\nimport { WebviewMainService }")
    replace(root, app, 'session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {',
        '''session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
			if (permission === 'media' && isUrlFromWebview(details.requestingUrl)) {
				void requestMediaCapture(webContents, details).then(callback, () => callback(false));
				return;
			}''')
    replace(root, app, 'session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => {',
        '''session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => {
			if (permission === 'media' && isUrlFromWebview(details.requestingUrl || _origin)) {
				return checkMediaCapture(webContents, details.requestingUrl || _origin, details.mediaType);
			}''')
    interface = 'src/vs/platform/webview/common/webviewManagerService.ts'
    replace(root, interface, '\tsetIgnoreMenuShortcuts(', '\tsetMediaCaptureOrigin(id: WebviewWebContentsId | WebviewWindowId, frame: string, origin: string, extension: string, enabled: boolean): Promise<void>;\n\n\tsetIgnoreMenuShortcuts(')
    replace(root, 'src/vs/workbench/contrib/webview/test/electron-browser/webviewElement.test.ts',
        '\t\t\tsetIgnoreMenuShortcuts: async () => { },',
        '\t\t\tsetMediaCaptureOrigin: async () => { },\n\t\t\tsetIgnoreMenuShortcuts: async () => { },')
    service = 'src/vs/platform/webview/electron-main/webviewMainService.ts'
    replace(root, service, 'export class WebviewMainService', "import { registerMediaCapture } from './dhimantaiMediaPermissions.js';\n\nexport class WebviewMainService")
    replace(root, service, '\tpublic async setIgnoreMenuShortcuts(', '''	public async setMediaCaptureOrigin(id: WebviewWebContentsId | WebviewWindowId, frame: string, origin: string, extension: string, enabled: boolean): Promise<void> {
		const contents = this.getWebContents(id);
		if (contents) { registerMediaCapture(contents, frame, origin, extension, enabled); }
	}

	public async setIgnoreMenuShortcuts(''')
    browser = 'src/vs/workbench/contrib/webview/browser/webviewElement.ts'
    replace(root, browser, "const allowRules = ['cross-origin-isolated', 'autoplay', 'local-network-access'];", "const allowRules = ['cross-origin-isolated', 'autoplay', 'local-network-access'];\n\t\tif (this.extension?.id.value === 'optficial.dhimantai-learning') { allowRules.push('microphone', 'camera'); }")
    replace(root, browser, '\tpublic mountTo(element:', '\tprotected async prepareWebviewOrigin(_origin: string): Promise<void> { }\n\n\tpublic mountTo(element:')
    replace(root, browser, 'this._encodedWebviewOriginPromise.then(encodedWebviewOrigin => {', 'this._encodedWebviewOriginPromise.then(async encodedWebviewOrigin => {\n\t\t\tawait this.prepareWebviewOrigin(encodedWebviewOrigin);')
    native = 'src/vs/workbench/contrib/webview/electron-browser/webviewElement.ts'
    replace(root, native, '\tprivate _findStarted:', '''	private _captureRegistration: { target: WebviewWebContentsId | WebviewWindowId; origin: string } | undefined;
	private _captureDisposed = false;
	private _findStarted:''')
    replace(root, native, '\toverride dispose(): void {', '''	override dispose(): void {
		this._captureDisposed = true;
		this.clearMediaCapture();''')
    replace(root, native, '\tprotected override webviewContentEndpoint(', '''	private clearMediaCapture(): void {
		const old = this._captureRegistration;
		this._captureRegistration = undefined;
		if (old) { void this._webviewMainService.setMediaCaptureOrigin(old.target, this.id, old.origin, 'optficial.dhimantai-learning', false).catch(onUnexpectedError); }
	}

	protected override async prepareWebviewOrigin(encodedOrigin: string): Promise<void> {
		this.clearMediaCapture();
		if (this.extension?.id.value !== 'optficial.dhimantai-learning' || this._captureDisposed) { return; }
		const registration = { target: this.findTarget, origin: this.webviewContentEndpoint(encodedOrigin) };
		this._captureRegistration = registration;
		await this._webviewMainService.setMediaCaptureOrigin(registration.target, this.id, registration.origin, this.extension.id.value, true);
		if (this._captureDisposed) { this.clearMediaCapture(); }
	}

	protected override webviewContentEndpoint(''')
    pre = 'src/vs/workbench/contrib/webview/browser/pre/index.html'
    replace(root, pre, "const allowRules = ['cross-origin-isolated;', 'autoplay;', 'local-network-access;'];", "const allowRules = ['cross-origin-isolated;', 'autoplay;', 'local-network-access;', \"microphone 'self';\", \"camera 'self';\"];")
    refresh_webview_csp(root / pre)
    # The app owns update identity. Never inherit VSCodium or Microsoft's release channel.
    product = json.loads((root / 'product.json').read_text())
    assert product['applicationName'] == 'dhimantai' and not product.get('electronArtifactFeed')
    # Build provenance is explicit; this capability does not silently turn on devices.
    product['dhimantaiDesktop'] = {'version': lock['release'], 'mediaCapture': True}
    # The learning extension injects its task player into practical-course pages through the integrated
    # browser's DevTools session. Only this extension receives the proposal.
    product.setdefault('extensionEnabledApiProposals', {})['optficial.dhimantai-learning'] = ['browser']
    (root / 'product.json').write_text(json.dumps(product, indent=2) + '\n')
    # Keep upstream copyright attribution; brand the distribution's package author.
    package = json.loads((root / 'package.json').read_text())
    package['author'] = {'name': 'Optficial Labs Pvt Ltd'}
    (root / 'package.json').write_text(json.dumps(package, indent=2) + '\n')


def configure_learning_updates(root):
    # Native installation must permit this bundled extension, but its own verified
    # service feed owns automatic updates, not the extension marketplace.
    path='src/vs/workbench/contrib/extensions/browser/extensionsWorkbenchService.ts'
    if "extension.identifier.id.toLowerCase() === 'optficial.dhimantai-learning'" in (root/path).read_text():
        raise RuntimeError('Learning extension updates already customized')
    replace(root,path,'\tprivate shouldAutoUpdateExtension(extension: IExtension): boolean {',
        "\tprivate shouldAutoUpdateExtension(extension: IExtension): boolean {\n\t\tif (extension.identifier.id.toLowerCase() === 'optficial.dhimantai-learning') { return false; }")


def preserve_updated_profile_extensions(root):
    # A single update can leave old and new VSIX directories beside each other.
    # Compare the version inside the serialized profile edit, where concurrent installs are visible.
    scanner = 'src/vs/platform/extensionManagement/common/extensionsProfileScannerService.ts'
    replace(root, scanner, 'export interface IScannedProfileExtension {',
        'interface IProfileExtensionRemoval extends IExtensionIdentifier { readonly version?: string }\n\n'
        'export interface IScannedProfileExtension {')
    signature = 'removeExtensionsFromProfile(extensions: IExtensionIdentifier[], profileLocation: URI)'
    for prefix in ('\n\t', '\n\tasync '):
        replace(root, scanner, prefix + signature,
            prefix + signature.replace('IExtensionIdentifier[]', 'IProfileExtensionRemoval[]'))
    replace(root, scanner, 'extensions.some(extension => areSameExtensions(e.identifier, extension))',
        'extensions.some(extension => areSameExtensions(e.identifier, extension)\n'
        '\t\t\t\t\t\t&& (extension.version === undefined || extension.version === e.version))')
    management = 'src/vs/platform/extensionManagement/node/extensionManagementService.ts'
    replace(root, management, 'removeExtensionsFromProfile(staleExtensions.map(e => e.identifier),',
        'removeExtensionsFromProfile(staleExtensions.map(e => ({ ...e.identifier, version: e.manifest.version })),')


def customize_navigation(root):
    hide_developer_views(root)
    replace(root, 'src/vs/workbench/contrib/welcomeGettingStarted/browser/startupPage.ts',
        'await this.lifecycleService.when(LifecyclePhase.Restored);',
        "await this.lifecycleService.when(LifecyclePhase.Restored);\n\t\tif (this.productService.applicationName === 'dhimantai') {\n\t\t\tif (!this.environmentService.skipWelcome) { await this.commandService.executeCommand('dhimantai.desktopWelcome'); }\n\t\t\treturn;\n\t\t}")
    replace(root, 'src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.contribution.ts',
        "'default': 'welcomePage',", "'default': 'none',")
    explorer = 'src/vs/workbench/contrib/files/browser/explorerViewlet.ts'
    # The extension owns the Learning sidebar. Keep Explorer as the native file browser.
    replace(root, explorer, 'name: localize2(\'folders\', "Folders"),', 'name: localize2(\'courseFiles\', "Course Files"),')
    replace(root, explorer, 'name: EmptyView.NAME,', 'name: localize2(\'courseFiles\', "Course Files"),\n\t\t\tcollapsed: true,')
    views = 'src/vs/workbench/api/browser/viewsExtensionPoint.ts'
    replace(root, views, 'collapsed: this.showCollapsed(container) || initialVisibility === InitialVisibility.Collapsed,',
        "collapsed: item.id === 'dhimantai.practice' || this.showCollapsed(container) || initialVisibility === InitialVisibility.Collapsed,")


LEARNING_SIDEBAR = 'workbench.view.extension.dhimantai-learning'


def hide_developer_activity(root):
    pane = 'src/vs/workbench/browser/parts/paneCompositeBar.ts'
    # Apply the same rule to restored profiles, new contributions and view activations.
    # The editor can still open the tool itself; it does not add a learner navigation icon.
    lookup = '\tprivate getViewContainer(id: string): ViewContainer | undefined {'
    replace(root, pane, lookup,
        f"\tprivate showsStudentRailItem(id: string): boolean {{\n"
        f"\t\treturn this.location !== ViewContainerLocation.Sidebar || id === '{LEARNING_SIDEBAR}';\n\t}}\n\n"
        + lookup + "\n\t\tif (!this.showsStudentRailItem(id)) { return undefined; }")
    replace(root, pane, 'return this.viewDescriptorService.getViewContainersByLocation(this.location);',
        'return this.viewDescriptorService.getViewContainersByLocation(this.location).filter(view => this.showsStudentRailItem(view.id));')
    replace(root, pane, 'for (const viewContainer of viewContainers) {\n\t\t\tthis.addComposite(viewContainer);',
        'for (const viewContainer of viewContainers) {\n\t\t\tif (!this.showsStudentRailItem(viewContainer.id)) { continue; }\n\t\t\tthis.addComposite(viewContainer);')
    replace(root, pane, 'return JSON.parse(this.pinnedViewContainersValue);',
        "const stored: IPinnedViewContainer[] = JSON.parse(this.pinnedViewContainersValue);\n"
        "\t\tif (this.location !== ViewContainerLocation.Sidebar) { return stored; }\n"
        "\t\treturn stored.filter(view => this.showsStudentRailItem(view.id)).map(view => ({ ...view, pinned: true }));")


# Status bar items a new learner cannot act on: the errors/warnings counter (squiggles and the
# Problems view stay) and the remote-connection indicator. A learner can show either again
# from the status bar's context menu; a profile that already chose hidden items keeps them.
LEARNER_HIDDEN_STATUS = ('status.problems', 'status.host')


def hide_developer_status(root):
    ids = ','.join(f'"{i}"' for i in LEARNER_HIDDEN_STATUS)
    replace(root, 'src/vs/workbench/browser/parts/statusbar/statusbarModel.ts',
        'const hiddenRaw = this.storageService.get(StatusbarViewModel.HIDDEN_ENTRIES_KEY, StorageScope.PROFILE);',
        f"const hiddenRaw = this.storageService.get(StatusbarViewModel.HIDDEN_ENTRIES_KEY, StorageScope.PROFILE, '[{ids}]');")


def hide_developer_views(root):
    hide_developer_activity(root)
    hide_developer_status(root)
    replace(root, 'src/vs/workbench/contrib/outline/browser/outline.contribution.ts',
        'hideByDefault: false,', 'hideByDefault: true,')
    replace(root, 'src/vs/workbench/contrib/timeline/browser/timeline.contribution.ts',
        'readonly hideByDefault = false;', 'readonly hideByDefault = true;')


def customize_appearance(root):
    replace(root, 'src/vs/workbench/services/themes/common/themeConfiguration.ts',
        'default: isWeb ? ThemeSettingDefaults.COLOR_THEME_LIGHT : ThemeSettingDefaults.COLOR_THEME_DARK,',
        'default: ThemeSettingDefaults.COLOR_THEME_LIGHT,')
    replace(root, 'src/vs/workbench/services/themes/common/workbenchThemeService.ts',
        "export const COLOR_THEME_LIGHT = 'Light 2026';", "export const COLOR_THEME_LIGHT = 'dhimantAI Light';")


def configure_brand(root):
    themes = root / 'extensions/theme-defaults/package.json'
    manifest = json.loads(themes.read_text())
    manifest['contributes']['themes'].append({'id': 'dhimantAI Light', 'label': 'dhimantAI Light',
        'uiTheme': 'vs', 'path': './themes/dhimantai-light.json'})
    themes.write_text(json.dumps(manifest, indent=2) + '\n')
    titlebar = 'src/vs/workbench/browser/parts/titlebar/titlebarPart.ts'
    anchor = "this.leftContent = append(this.rootContainer, $('.titlebar-left'));"
    replace(root, titlebar, anchor, anchor + """
        const brand = append(this.leftContent, $('.dhimantai-wordmark'));
        append(brand, $('span.dhimantai-mark'));
        append(brand, $('span.dhimantai-name', undefined, 'dhimant', $('b', undefined, 'AI')));""".replace('    ', '\t'))
    anchor = "if (isMacintosh && isNative && primaryWindowControlsLocation === 'left') {"
    replace(root, titlebar, anchor, anchor + "\n\t\t\t\tbrand.classList.add('after-window-controls');")
    # Use the book artwork bundled with the learning extension.
    mark = root / 'src/vs/workbench/browser/parts/media/dhimantai-mark.png'
    mark.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT.parent / 'dhimantai-learning/media/auth/dhimantai.png', mark)


def configure_skilling_shell(root):
    menu = 'src/vs/workbench/browser/parts/titlebar/menubar.contribution.ts'
    replace(root, menu, "import { IsMacNativeContext }",
        "import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';\nimport '../../../contrib/dhimantai/browser/skillingMenus.contribution.js';\nimport { IsMacNativeContext }")
    for name in ('File', 'Edit', 'View'):
        # Keep upstream titles and mnemonics. Only a file or notebook needs file and view commands.
        condition = "" if name == 'Edit' else "\n\twhen: ContextKeyExpr.has('dhimantai.editingFiles'),"
        replace(root, menu, f'submenu: MenuId.Menubar{name}Menu,', f"submenu: MenuId.for('dhimantai.learning{name}')," + condition)
    for name in ('Selection', 'Go', 'Terminal', 'Help'):
        anchor = f'submenu: MenuId.Menubar{name}Menu,'
        replace(root, menu, anchor, anchor + '\n\twhen: ContextKeyExpr.false(),')
    replace(root, 'src/vs/workbench/contrib/debug/browser/debug.contribution.ts',
        "order: 6,\n\twhen: IsSessionsWindowContext.negate()", "order: 6,\n\twhen: ContextKeyExpr.false()")
    replace(root, 'src/vs/workbench/contrib/debug/browser/debug.contribution.ts',
        'import { FocusedViewContext, IsSessionsWindowContext }', 'import { FocusedViewContext }')
    # A focused teaching iframe can leave the workbench document without DOM focus.
    # Use Electron's window identity to decide which window owns the application menu.
    renderer = 'src/vs/workbench/electron-browser/parts/titlebar/menubarControl.ts'
    replace(root, renderer, '\t\t// Since the native menubar is shared between windows (main process)\n'
        '\t\t// only allow the focused window to update the menubar\n\t\tif (!this.hostService.hasFocus) {\n\t\t\treturn;\n\t\t}\n\n', '')
    native = 'src/vs/platform/menubar/electron-main/menubar.ts'
    anchor = 'updateMenu(menubarData: IMenubarData, windowId: number) {'
    replace(root, native, anchor, anchor + """
        const active = this.windowsMainService.getFocusedWindow() ?? this.windowsMainService.getLastActiveWindow();
        if (active?.id !== windowId) { return; }""".replace('    ', '\t'))
    # Electron has its own top-level list in addition to the renderer's menu registry.
    anchor = "\t\t// File\n\t\tif (this.shouldDrawMenu('File'))"
    replace(root, native, anchor, """
        if (this.shouldDrawMenu('Skilling')) {
            const menu = new Menu();
            this.setMenuById(menu, 'Skilling');
            menubar.append(new MenuItem({ label: this.mnemonicLabel(nls.localize('mSkilling', "S&&killing")), submenu: menu }));
        }
""".lstrip('\n').replace('    ', '\t') + '\n' + anchor)
    replace(root, 'src/vs/workbench/browser/parts/editor/editorGroupView.ts',
        "import { EditorGroupWatermark } from './editorGroupWatermark.js';",
        "import { SkillingWelcome as EditorGroupWatermark } from '../skillingWelcome.js';")
    replace(root, 'src/vs/workbench/browser/workbench.contribution.ts', "'default': defaultWindowTitle,",
        "'default': defaultWindowTitle + '${separator}Skilling',")
    # Keep the normal folder chooser and its warning about closing existing editors.
    explorer = 'src/vs/workbench/contrib/files/browser/explorerViewlet.ts'
    replace(root, explorer, "const openFolderButton = `[${openFolder}]", "const openFolderButton = `[${localize('openProjectFolder', 'Open Project Folder')}]")
    replace(root, explorer, '"You have not yet opened a folder.\\n{0}", openFolderButton',
        '"Open a project to see its files here.\\n{0}", openFolderButton')


def configure_app_bar(root):
    replace(root, 'src/vs/workbench/browser/parts/activitybar/activitybarPart.ts',
        "import { GlobalCompositeBar } from '../globalCompositeBar.js';",
        "import { DhimantaiAppBar as GlobalCompositeBar } from '../dhimantaiAppBar.js';")


def configure_course_copilot(root):
    replace(root, 'src/vs/workbench/workbench.desktop.main.ts',
        "import './workbench.common.main.js';",
        "import './workbench.common.main.js';\nimport './contrib/dhimantai/browser/courseCopilot.contribution.js';")
    # Upstream omits memory configuration from extension-host snapshots. Carry
    # only this course switch so Copilot sees the same value as the workbench,
    # including the previous value used by affectsConfiguration events.
    replace(root, 'src/vs/platform/configuration/common/configuration.ts',
        'export interface IConfigurationData {',
        'export interface IConfigurationData {\n\tdhimantaiCourseCopilotDisabled?: boolean;')
    models = 'src/vs/platform/configuration/common/configurationModels.ts'
    replace(root, models, '\ttoData(): IConfigurationData {\n\t\treturn {',
        "\ttoData(): IConfigurationData {\n\t\treturn {\n\t\t\tdhimantaiCourseCopilotDisabled: this._memoryConfiguration.getValue<boolean>('chat.disableAIFeatures'),")
    replace(root, models, '\tstatic parse(data: IConfigurationData, logService: ILogService): Configuration {',
        '''\tstatic parse(data: IConfigurationData, logService: ILogService): Configuration {
\t\tconst courseMemory = ConfigurationModel.createEmptyModel(logService);
\t\tif (typeof data.dhimantaiCourseCopilotDisabled === 'boolean') {
\t\t\tcourseMemory.setValue('chat.disableAIFeatures', data.dhimantaiCourseCopilotDisabled);
\t\t}''')
    replace(root, models,
        '\t\t\tfolders,\n\t\t\tConfigurationModel.createEmptyModel(logService),\n\t\t\tnew ResourceMap<ConfigurationModel>(),',
        '\t\t\tfolders,\n\t\t\tcourseMemory,\n\t\t\tnew ResourceMap<ConfigurationModel>(),')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    customize(parser.parse_args().source.resolve())
