import { validateFontSource, validatePresentationAttribute, validatePresentationElement } from "./presentation-policy";

let validateBrowserTree: (node: Node) => void = () => { throw new Error("UNSUPPORTED_CAPABILITY"); };
export function assertPresentationTree(node: Node): void { validateBrowserTree(node); }

/** Install before application evaluation; trusted transport retains its own handles. */
export function restrictBrowserRealms(): void {
  const denied = (): never => { throw new Error("UNSUPPORTED_CAPABILITY"); };
  const apply = Reflect.apply;
  const string = String;
  const childLength = Object.getOwnPropertyDescriptor(NodeList.prototype, "length")!.get!;
  const childAt = NodeList.prototype.item;
  const nodeType = Object.getOwnPropertyDescriptor(Node.prototype, "nodeType")!.get!;
  const localName = Object.getOwnPropertyDescriptor(Element.prototype, "localName")!.get!;
  const children = Object.getOwnPropertyDescriptor(Node.prototype, "childNodes")!.get!;
  const templateContent = Object.getOwnPropertyDescriptor(HTMLTemplateElement.prototype, "content")!.get!;
  const attributes = Object.getOwnPropertyDescriptor(Element.prototype, "attributes")!.get!;
  const attributeLength = Object.getOwnPropertyDescriptor(NamedNodeMap.prototype, "length")!.get!;
  const attributeAt = NamedNodeMap.prototype.item;
  const attributeName = Object.getOwnPropertyDescriptor(Attr.prototype, "name")!.get!;
  const attributeValue = Object.getOwnPropertyDescriptor(Attr.prototype, "value")!;
  const ownerElement = Object.getOwnPropertyDescriptor(Attr.prototype, "ownerElement")!.get!;
  const validateAttribute = (element: Element, name: string, value: string): void => {
    const tag = apply(localName, element, []) as string;
    validatePresentationElement(tag);
    validatePresentationAttribute(tag, name, value);
  };
  const safe = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    let type: number;
    try { type = apply(nodeType, value, []) as number; } catch { return; }
    if (type === 1) {
      const tag = apply(localName, value, []) as string;
      validatePresentationElement(tag);
      const list = apply(attributes, value, []);
      const length = apply(attributeLength, list, []) as number;
      for (let index = 0; index < length; index++) {
        const attribute = apply(attributeAt, list, [index]);
        validateAttribute(value as Element, apply(attributeName, attribute, []) as string, apply(attributeValue.get!, attribute, []) as string);
      }
      if (tag === "template") safe(apply(templateContent, value, []));
    }
    const list = apply(children, value, []);
    const length = apply(childLength, list, []) as number;
    for (let index = 0; index < length; index++) safe(apply(childAt, list, [index]));
  };
  const seal = (target: object, name: string, value: unknown) => Object.defineProperty(target, name, { value, writable: false, configurable: false });
  const construct = Reflect.construct;
  const isView = ArrayBuffer.isView;
  const font = new Proxy(FontFace, { construct(target, args) {
    if (!(args[1] instanceof ArrayBuffer) && !isView(args[1])) {
      args[1] = string(args[1]);
      validateFontSource(args[1]);
    }
    return construct(target, args);
  } });
  seal(FontFace.prototype, "constructor", font);
  seal(globalThis, "FontFace", font);
  // Constructors remain reachable through function prototypes after replacing
  // the globals, so close those paths before application code can retain them.
  for (const constructor of [Function, Object.getPrototypeOf(async () => {}).constructor, Object.getPrototypeOf(function* () {}).constructor, Object.getPrototypeOf(async function* () {}).constructor]) {
    seal(constructor.prototype, "constructor", denied);
  }
  seal(globalThis, "Function", denied);
  for (const name of ["setTimeout", "setInterval"] as const) {
    const original = globalThis[name];
    seal(globalThis, name, (handler: unknown, ...args: unknown[]) => {
      if (typeof handler !== "function") return denied();
      return apply(original, globalThis, [handler, ...args]);
    });
  }
  // Inline element.style declarations remain available. Rules in Fleur's
  // stylesheet and independently constructed sheets are never application APIs.
  for (const name of ["insertRule", "deleteRule", "addRule", "removeRule", "replace", "replaceSync"]) {
    if (name in CSSStyleSheet.prototype) seal(CSSStyleSheet.prototype, name, denied);
  }
  for (const name of ["cssRules", "rules"]) {
    if (Object.getOwnPropertyDescriptor(CSSStyleSheet.prototype, name)) Object.defineProperty(CSSStyleSheet.prototype, name, { get: denied, configurable: false });
  }
  for (const target of [Document.prototype, ShadowRoot.prototype]) {
    if (Object.getOwnPropertyDescriptor(target, "adoptedStyleSheets")) Object.defineProperty(target, "adoptedStyleSheets", { get: denied, set: denied, configurable: false });
  }
  for (const name of ["setAttribute", "setAttributeNS"] as const) {
    const original = Element.prototype[name];
    seal(Element.prototype, name, function(this: Element, ...args: unknown[]) {
      const offset = name === "setAttributeNS" ? 1 : 0;
      const attribute = string(args[offset]), value = string(args[offset + 1]);
      validateAttribute(this, attribute, value);
      return apply(original, this, offset ? [args[0], attribute, value] : [attribute, value]);
    });
  }
  // Attribute nodes offer independent setters that otherwise bypass setAttribute.
  for (const name of ["setAttributeNode", "setAttributeNodeNS"]) seal(Element.prototype, name, denied);
  for (const name of ["setNamedItem", "setNamedItemNS"]) seal(NamedNodeMap.prototype, name, denied);
  Object.defineProperty(Attr.prototype, "value", { get: attributeValue.get, set(this: Attr, value: unknown) {
    const text = string(value), owner = apply(ownerElement, this, []) as Element | null;
    if (owner) validateAttribute(owner, apply(attributeName, this, []) as string, text);
    apply(attributeValue.set!, this, [text]);
  }, configurable: false });
  for (const name of ["textContent", "nodeValue"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(Node.prototype, name)!;
    Object.defineProperty(Node.prototype, name, { get: descriptor.get, set(this: Node, value: unknown) {
      const type = apply(nodeType, this, []);
      if (type === 1) validatePresentationElement(apply(localName, this, []) as string);
      if (type === 2) {
        value = value == null ? "" : string(value);
        const owner = apply(ownerElement, this, []) as Element | null;
        if (owner) validateAttribute(owner, apply(attributeName, this, []) as string, value as string);
      }
      apply(descriptor.set!, this, [value]);
    }, configurable: false });
  }
  for (const [target, names] of [
    [HTMLLinkElement.prototype, ["href", "rel", "type", "media", "disabled"]],
    [HTMLScriptElement.prototype, ["src", "type", "text"]],
    [HTMLImageElement.prototype, ["src", "srcset"]], [HTMLSourceElement.prototype, ["src", "srcset"]],
    [HTMLMediaElement.prototype, ["src"]], [HTMLVideoElement.prototype, ["poster"]],
    [HTMLAnchorElement.prototype, ["href", "ping"]], [HTMLAreaElement.prototype, ["href", "ping"]],
    [HTMLInputElement.prototype, ["src", "formAction"]], [HTMLButtonElement.prototype, ["formAction"]],
    [HTMLFormElement.prototype, ["action"]],
  ] as const) for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (!descriptor?.set) continue;
    Object.defineProperty(target, name, { get: descriptor.get, set(this: Element, value: unknown) {
      const text = string(value);
      validateAttribute(this, name, text);
      apply(descriptor.set!, this, [text]);
    }, configurable: false });
  }
  // SVG animated values can change links without touching Element attributes.
  const baseValue = Object.getOwnPropertyDescriptor(SVGAnimatedString.prototype, "baseVal")!;
  Object.defineProperty(SVGAnimatedString.prototype, "baseVal", { get: baseValue.get, set: denied, configurable: false });
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
  validateBrowserTree = safe;
}
