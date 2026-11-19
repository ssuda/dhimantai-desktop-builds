/** Preparation failed before the notebook sent any learner code to its runtime. */
export class RuntimePreparationError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), {cause});
    this.name = 'RuntimePreparationError';
  }
}
