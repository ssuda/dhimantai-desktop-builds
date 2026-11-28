export const FREECAD_COURSE = 'Mechanical Design with FreeCAD';
export const FREECAD_CHAPTER = 'f47e96e2-6ea1-5bc9-9f0b-2fc23b78e9ca';
export const cadActions = ['observe','top_view','isometric_view','select_bore','open_radius',
  'demonstrate_radius','show_save','end_demo'] as const;
export type CadAction = typeof cadActions[number];
export function cadAction(value: unknown): value is CadAction {
  return cadActions.some(action=>action===value);
}
