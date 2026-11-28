import {setTimeout as delay} from 'node:timers/promises';
import {DesktopWindow, openDesktopControl, ScreenPoint} from './desktopControl';
import {CadAction} from './freecadCourse';
import type {CadState} from './freecadLesson';

export interface FreeCADControls {
  focused: boolean;
  busy: boolean;
  bore?: ScreenPoint;
  expand?: ScreenPoint;
  data?: ScreenPoint;
  radius?: ScreenPoint;
  expandRadius?: ScreenPoint;
  save?: ScreenPoint;
  radiusEditing?: boolean;
  radiusCurrent?: boolean;
  radiusSelected?: boolean;
  radiusText?: string;
}

export function freecadDemonstration(observe: () => Promise<CadState>, signal: AbortSignal) {
  let driver: Awaited<ReturnType<typeof openDesktopControl>> | undefined;
  let running = false;
  const close = async () => {
    const previous = driver;
    driver = undefined;
    await previous?.close();
  };
  signal.addEventListener('abort', () => void close(), {once: true});

  async function ready() {
    const state = await observe();
    if (state.status !== 'ready' || !state.pid || !state.title || !state.controls || state.controls.busy) {
      throw new Error('The FreeCAD exercise is busy or no longer active.');
    }
    return {...state, target: {pid: state.pid, title: state.title}, ui: state.controls};
  }
  type UIState = Awaited<ReturnType<typeof ready>>;
  async function changed(predicate: (state: UIState) => boolean) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const state = await ready();
      if (predicate(state)) return state;
      await delay(100, undefined, {signal});
    }
    throw new Error('FreeCAD did not confirm the requested UI change.');
  }
  function hasBore(state: UIState) {
    return state.selected?.length === 1 && state.selected[0] === 'Bore';
  }
  return async (action: Exclude<CadAction, 'observe'>): Promise<CadState> => {
    if (running) return {status: 'editing'};
    running = true;
    try {
      if (action === 'end_demo') {
        await close();
        return {status: 'ended'};
      }
      let state = await ready();
      driver ??= await openDesktopControl(signal);
      if (action === 'select_bore' || action === 'top_view' || action === 'isometric_view') {
        if (!state.ui.focused) {
          await driver.focus(state.target);
          state = await changed(next => next.ui.focused);
        }
      } else if (!state.ui.focused) return {status: 'editing'};

      if (action === 'select_bore') {
        for (let depth = 0; depth < 2 && state.ui.expand; depth++) {
          const parent = state.ui.expand;
          await driver.pointer(state.target, parent, 1);
          state = await changed(next => !next.ui.expand || next.ui.expand.x !== parent.x || next.ui.expand.y !== parent.y);
        }
        if (!state.ui.bore) return {status: 'controls_unavailable'};
        await driver.pointer(state.target, state.ui.bore, 1);
        state = await changed(hasBore);
      } else if (action === 'open_radius') {
        if (!hasBore(state)) return {status: 'editing'};
        if (state.ui.data) {
          await driver.pointer(state.target, state.ui.data, 1);
          state = await changed(next => !next.ui.data);
        }
        if (state.ui.expandRadius) {
          await driver.pointer(state.target, state.ui.expandRadius, 1);
          state = await changed(next => !!next.ui.radius);
        }
        if (!state.ui.radius) return {status: 'controls_unavailable'};
        await driver.pointer(state.target, state.ui.radius, state.ui.radiusEditing ? undefined : 1);
        state = await changed(next => hasBore(next) && next.ui.radiusCurrent === true);
        if (!state.ui.radiusEditing && state.ui.focused) {
          await driver.key(state.target, process.platform === 'darwin' ? 'return' : 'f2');
        }
        state = await changed(next => hasBore(next) && next.ui.radiusEditing === true);
      } else if (action === 'demonstrate_radius') {
        if (!state.starter || state.radius !== 7) return {status: 'changed'};
        if (!hasBore(state) || !state.ui.radiusEditing) return {status: 'editing'};
        if (!state.ui.radiusSelected) {
          const target: DesktopWindow = state.target;
          await driver.key(target, 'a', [process.platform === 'darwin' ? 'cmd' : 'ctrl']);
          state = await changed(next => hasBore(next) && next.ui.radiusSelected === true && next.radius === 7);
        }
        await driver.key(state.target, '6');
        state = await changed(next => hasBore(next) && next.ui.radiusEditing === true && (next.radius === 7 || next.radius === 6)
          && /^6(?:[.,]0+)?(?:\s*mm)?$/i.test(next.ui.radiusText?.trim() ?? ''));
        await driver.key(state.target, 'return');
        state = await changed(next => next.radius === 6 && next.validSolid === true);
      } else if (action === 'show_save') {
        if (!state.ui.save) return {status: 'controls_unavailable'};
        await driver.pointer(state.target, state.ui.save);
      } else {
        await driver.menu(state.target, ['View', 'Standard Views', action === 'top_view' ? 'Top' : 'Isometric']);
        state = await ready();
      }
      return {status: 'ready', radius: state.radius, validSolid: state.validSolid, selected: state.selected};
    } catch (error) {
      await close();
      return {status: error instanceof Error && /permission|ENOENT|not running/i.test(error.message)
        ? 'driver_unavailable' : 'controls_unavailable'};
    } finally {
      running = false;
    }
  };
}
