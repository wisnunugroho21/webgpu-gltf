/** Report a missing viewer element at its lookup, rather than at a later callback. */
export function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing viewer element #${id}.`);
  return value as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function disableControls(disabled: boolean): void {
  document
    .querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(
      'button, input, select',
    )
    .forEach((control) => {
      control.disabled = disabled;
    });
}
