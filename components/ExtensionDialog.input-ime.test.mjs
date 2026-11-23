import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
const { cleanup, fireEvent, render, screen } = await import("@testing-library/react/pure.js");
const { default: userEvent } = await import("@testing-library/user-event");

const { ExtensionDialog } = await import("./ExtensionDialog.tsx");

afterEach(cleanup);

function renderInput() {
  const responses = [];
  render(React.createElement(ExtensionDialog, {
    request: { type: "ui_request", id: 1, method: "input", args: ["Your name", "Type your name"] },
    onRespond: (_request, value) => responses.push(value),
    attached: true,
  }));
  return responses;
}

test("an IME-confirming Enter (keyCode 229) does not submit the input dialog; a plain Enter does (#516)", async () => {
  const user = userEvent.setup();
  const responses = renderInput();
  const input = screen.getByRole("textbox", { name: "Your name" });
  await user.type(input, "test");
  // The Enter that confirms an IME conversion carries keyCode 229 (and on
  // macOS Safari isComposing is already false by then): it must not submit.
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  assert.deepEqual(responses, []);
  fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });
  assert.deepEqual(responses, ["test"]);
});
