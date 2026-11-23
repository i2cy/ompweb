import assert from "node:assert/strict";
import test from "node:test";

const { isImeConfirmEnter } = await import("./ime-enter.ts");

test("an Enter during composition is an IME confirmation, not a commit (#516)", () => {
  assert.equal(isImeConfirmEnter({ nativeEvent: { isComposing: true, keyCode: 229 } }), true);
  assert.equal(isImeConfirmEnter({ nativeEvent: { isComposing: true, keyCode: 13 } }), true);
  // macOS Safari delivers compositionend before the confirming Enter keydown,
  // so isComposing is already false; the 229 key code still identifies it.
  assert.equal(isImeConfirmEnter({ nativeEvent: { isComposing: false, keyCode: 229 } }), true);
  // A plain Enter outside composition commits.
  assert.equal(isImeConfirmEnter({ nativeEvent: { isComposing: false, keyCode: 13 } }), false);
  // Native (non-React) events carry the flags directly.
  assert.equal(isImeConfirmEnter({ isComposing: true, keyCode: 13 }), true);
  assert.equal(isImeConfirmEnter({ keyCode: 229 }), true);
  assert.equal(isImeConfirmEnter({ keyCode: 13 }), false);
});
