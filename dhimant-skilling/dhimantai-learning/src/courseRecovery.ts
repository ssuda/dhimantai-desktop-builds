/** A course runtime failure that rebuilding the container can fix: the container is missing or stopped,
 * or a readiness, import or verification check failed. Install, permission and network errors are not. */
export class RepairableCourseError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error), {cause: error});
    this.name = 'RepairableCourseError';
  }
}

/** Mark failures of one runtime step as fixable by a rebuild. */
export const repairable = <T>(step: Promise<T>) =>
  step.catch((error: unknown): never => { throw error instanceof RepairableCourseError ? error : new RepairableCourseError(error); });

/** Wait for course setup; repair a repairable startup failure once and resume the same request.
 * Other errors, and a repeated failure, stay course errors. It never authorizes a local fallback. */
export async function withCourseRepair<T>(start: () => Promise<T>, repair: (error: unknown) => Promise<void>): Promise<T> {
  try { return await start(); }
  catch (error) {
    if (!(error instanceof RepairableCourseError)) throw error;
    await repair(error); return start();
  }
}
