// IME-safe Enter handling (issue #516): the Enter that confirms an IME
// conversion still arrives as a keydown with key === "Enter". It must not
// commit a rename, alias or dialog input. ChatInput.tsx already guards its
// composer this way (isComposingRef + nativeEvent.isComposing +
// keyCode === 229 + a 100 ms grace window after compositionend); this shared
// helper lets the smaller inputs do the same.
//
// Two signals, either is enough:
// - `isComposing` — true while a conversion is in progress, except on
//   macOS Safari, where WebKit delivers `compositionend` before the
//   confirming Enter keydown (WebKit bug 165004), so it is already false.
// - `keyCode === 229` — the IME composition key code, which covers Safari:
//   the confirming Enter still carries it.
export function isImeConfirmEnter(event: {
  readonly nativeEvent?: { readonly isComposing?: boolean; readonly keyCode?: number } | null;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
}): boolean {
  const nativeEvent = event.nativeEvent;
  const isComposing = nativeEvent?.isComposing ?? event.isComposing ?? false;
  const keyCode = nativeEvent?.keyCode ?? event.keyCode;
  return isComposing || keyCode === 229;
}
