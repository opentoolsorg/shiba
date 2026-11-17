/** Apply synchronously, then reconcile or undo only the mutation's own changes. */
export async function optimisticMutation<T>(options: {
  apply: () => void;
  commit: () => Promise<T>;
  reconcile: (value: T) => void;
  rollback: () => void;
  onError: (error: unknown) => void;
}): Promise<T | undefined> {
  options.apply();
  try {
    const value = await options.commit();
    options.reconcile(value);
    return value;
  } catch (error) {
    options.rollback();
    options.onError(error);
    return undefined;
  }
}
