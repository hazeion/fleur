import { hydrate, render } from "preact";
import { Editor } from "./island";
import { validateProps } from "./props";

const root = document.getElementById("editor");
const status = document.querySelector('[role="status"]');
const descriptor = document.getElementById("props");
if (!root || !status || !descriptor) throw new Error("Missing fixture descriptor");
const islandRoot = root;
const fixtureStatus = status;
try {
  const props = validateProps(JSON.parse(descriptor.textContent ?? "null"));
  hydrate(<Editor {...props} />, islandRoot);
} catch {
  fixtureStatus.textContent = "Rejected initial props";
}
async function refresh(invalid: boolean) {
  try {
    const response = await fetch(`/refresh${invalid ? "?invalid=1" : ""}`);
    if (!response.ok) throw new Error("Refresh failed");
    const result: { html: string; props: unknown } = await response.json();
    // Validate before either server DOM or island props can change.
    const props = validateProps(result.props);
    const template = document.createElement("template");
    template.innerHTML = result.html;
    const current = document.getElementById("server-name");
    const replacement = template.content.firstElementChild;
    if (!current || !replacement) throw new Error("Missing server region");
    current.replaceWith(replacement);
    // Keep the existing island root and Preact component identity.
    render(<Editor {...props} />, islandRoot);
    fixtureStatus.textContent = "Refreshed";
  } catch {
    fixtureStatus.textContent = "Rejected refresh props";
  }
}
window.addEventListener("fixture-refresh", () => { void refresh(false); });
window.addEventListener("fixture-invalid-refresh", () => { void refresh(true); });
