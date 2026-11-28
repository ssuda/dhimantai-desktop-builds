// Expose the real browser modules to the isolated JSDOM windows used by the tests.
import { bindDiagramBlocks } from '../../webview/diagramBlocks';
import { diagram } from '../../webview/diagram';
import { markdownPlainText, renderBoard } from '../../webview/markdown';
import * as visuals from '../../webview/visual';

window.Board = { bindDiagramBlocks, markdownPlainText, renderBoard };
window.Visual = { ...visuals, diagram, markdownPlainText, renderBoard };
