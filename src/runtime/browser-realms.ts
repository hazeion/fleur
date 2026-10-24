/** Executable frames and HTML parsing are outside the approved application API. */
export function restrictBrowserRealms(): void {
  const denied = (): never => { throw new Error("UNSUPPORTED_CAPABILITY"); };
  const forbidden = new Set(["iframe", "frame", "frameset", "object", "embed", "script", "portal", "fencedframe"]);
  const apply = Reflect.apply;
  const includes = forbidden.has.bind(forbidden);
  const lowercase = String.prototype.toLowerCase;
  const childLength = Object.getOwnPropertyDescriptor(NodeList.prototype, "length")!.get!;
  const childAt = NodeList.prototype.item;
  const nodeType = Object.getOwnPropertyDescriptor(Node.prototype, "nodeType")!.get!;
  const localName = Object.getOwnPropertyDescriptor(Element.prototype, "localName")!.get!;
  const children = Object.getOwnPropertyDescriptor(Node.prototype, "childNodes")!.get!;
  const safe = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    let type: number;
    try { type = apply(nodeType, value, []) as number; } catch { return; }
    if (type === 1 && includes(apply(lowercase, apply(localName, value, []), []) as string)) denied();
    const list = apply(children, value, []);
    const length = apply(childLength, list, []) as number;
    for (let index = 0; index < length; index++) safe(apply(childAt, list, [index]));
  };
  const seal = (target: object, name: string, value: unknown) => Object.defineProperty(target, name, { value, writable: false, configurable: false });
  seal(window, "open", denied);
  seal(window, "showModalDialog", denied);
  seal(window, "documentPictureInPicture", Object.freeze({ requestWindow: denied }));
  window.opener = null;
  for (const name of ["createElement", "createElementNS"] as const) {
    const original = Document.prototype[name];
    seal(Document.prototype, name, function(this: Document, ...args: unknown[]) {
      const node: unknown = apply(original, this, args);
      safe(node);
      return node;
    });
  }
  // Cover insertion of nodes originating in XML documents, imported subtrees,
  // fragments or clones as well as ordinary document.createElement calls.
  for (const [target, methods] of [
    [Node.prototype, ["appendChild", "insertBefore", "replaceChild"]],
    [Element.prototype, ["append", "prepend", "before", "after", "replaceWith", "replaceChildren", "insertAdjacentElement", "moveBefore"]],
    [Document.prototype, ["append", "prepend", "replaceChildren", "moveBefore"]],
    [DocumentFragment.prototype, ["append", "prepend", "replaceChildren", "moveBefore"]],
    [CharacterData.prototype, ["before", "after", "replaceWith"]],
    [DocumentType.prototype, ["before", "after", "replaceWith"]],
    [Range.prototype, ["insertNode", "surroundContents"]],
  ] as const) for (const name of methods) {
    const original: unknown = Reflect.get(target, name);
    if (typeof original !== "function") continue;
    seal(target, name, function(this: object, ...args: unknown[]) { for (let index = 0; index < args.length; index++) safe(args[index]); return apply(original, this, args); });
  }
  // Parsing arbitrary HTML would bypass node construction and its validation.
  for (const target of [Element.prototype, ShadowRoot.prototype]) {
    for (const name of ["innerHTML", "outerHTML"]) {
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      if (descriptor) Object.defineProperty(target, name, { get: descriptor.get, set: denied, configurable: false });
    }
    for (const name of ["setHTML", "setHTMLUnsafe", "insertAdjacentHTML"]) if (name in target) seal(target, name, denied);
  }
  for (const [target, names] of [[Document.prototype, ["write", "writeln", "execCommand"]], [Range.prototype, ["createContextualFragment"]], [DOMParser.prototype, ["parseFromString"]], [Document, ["parseHTML", "parseHTMLUnsafe"]]] as const) {
    for (const name of names) if (name in target) seal(target, name, denied);
  }
}
