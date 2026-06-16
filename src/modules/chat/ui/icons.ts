const SVG_NS = "http://www.w3.org/2000/svg";

export type IconName =
  | "agent"
  | "chat"
  | "settings"
  | "prompts"
  | "add"
  | "attachment"
  | "cloud"
  | "upload"
  | "image"
  | "video"
  | "web"
  | "stop"
  | "more"
  | "newChat"
  | "save"
  | "send"
  | "chevron-left"
  | "chevron-right"
  | "chevron-down"
  | "chevron-up"
  | "play"
  | "pause"
  | "stop-circle"
  | "copy"
  | "edit"
  | "refresh"
  | "tts"
  | "loading"
  | "close"
  | "tag"
  | "search"
  | "library"
  | "review"
  | "explore"
  | "focus"
  | "lock"
  | "prompt"
  | "trash"
  | "paper"
  | "table"
  | "folder"
  | "folder-open"
  | "user"
  | "users"
  | "calendar"
  | "calendar-star"
  | "target"
  | "lightning"
  | "tool"
  | "brain"
  | "image-stack"
  | "image-multiple"
  | "download"
  | "open-link"
  | "warning"
  | "check"
  | "check-circle"
  | "x-circle"
  | "question"
  | "help"
  | "block"
  | "sparkle"
  | "idea"
  | "bookmark"
  | "flag"
  | "fire"
  | "firecrawl"
  | "thumbs-up"
  | "thumbs-down"
  | "scale"
  | "eye"
  | "pin"
  | "info"
  | "hourglass"
  | "globe"
  | "home"
  | "logout"
  | "server"
  | "terminal"
  | "swap"
  | "list"
  | "rocket"
  | "robot"
  | "compass"
  | "database"
  | "share"
  | "star"
  | "shield"
  | "zap"
  | "cpu"
  | "message"
  | "sparkles";

const ICON_PATHS: Record<IconName, string> = {
  agent:
    "M12 3a4 4 0 0 0-4 4v1H6.5A2.5 2.5 0 0 0 4 10.5v5A2.5 2.5 0 0 0 6.5 18H8v2h8v-2h1.5a2.5 2.5 0 0 0 2.5-2.5v-5A2.5 2.5 0 0 0 17.5 8H16V7a4 4 0 0 0-4-4Zm-2 8a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm6 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm-6 4h4",
  chat: "M5 5h14v10H9l-4 4V5Z",
  settings:
    "M12 8.5A3.5 3.5 0 1 0 12 15.5 3.5 3.5 0 0 0 12 8.5Zm0-5 1 2.1 2.3.5 1.7-1.4 1.8 1.8-1.4 1.7.5 2.3 2.1 1-2.1 1-.5 2.3 1.4 1.7-1.8 1.8-1.7-1.4-2.3.5-1 2.1-1-2.1-2.3-.5-1.7 1.4-1.8-1.8 1.4-1.7-.5-2.3-2.1-1 2.1-1 .5-2.3-1.4-1.7 1.8-1.8 1.7 1.4 2.3-.5 1-2.1Z",
  prompts: "M4 5h16v14H4V5Zm2 3 3 3-3 3M10 16h6",
  add: "M12 5v14M5 12h14",
  attachment:
    "M8.5 12.5 14 7a3 3 0 1 1 4.2 4.2l-7.1 7.1a5 5 0 0 1-7.1-7.1l7.8-7.8",
  cloud: "M7 18h10a4 4 0 0 0 .4-8 6 6 0 0 0-11.5 1.7A3.2 3.2 0 0 0 7 18Z",
  upload: "M12 16V5m0 0L8 9m4-4 4 4M5 19h14",
  image:
    "M4 5h16v14H4V5Zm3 10 3-3 2.5 2.5L15 12l3 3M8.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
  video: "M4 6h11v12H4V6Zm11 4 5-3v10l-5-3",
  web: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0c2.2 2.4 3.3 5.4 3.3 9S14.2 18.6 12 21m0-18C9.8 5.4 8.7 8.4 8.7 12s1.1 6.6 3.3 9M3.5 9h17M3.5 15h17",
  stop: "M7 7h10v10H7V7Z",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  newChat: "M5 5h14v11H9l-4 4V5Zm7 2v6m-3-3h6",
  save: "M5 4h12l2 2v14H5V4Zm3 0v6h8V4M8 20v-6h8v6",
  send: "M4 4l17 8-17 8 3-8-3-8Zm3 8h14",
  "chevron-left": "m14 6-6 6 6 6",
  "chevron-right": "m10 6 6 6-6 6",
  "chevron-down": "m6 10 6 6 6-6",
  "chevron-up": "m6 14 6-6 6 6",
  play: "M7 5v14l12-7L7 5Z",
  pause: "M8 5v14M16 5v14",
  "stop-circle": "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-3 6h6v6H9V9Z",
  copy: "M9 4h11v14H9V4Zm-4 4v12h12",
  edit: "M4 20h4l10-10-4-4L4 16v4Zm12-12 2-2a2 2 0 1 1 2.8 2.8l-2 2",
  refresh: "M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M20 4v4h-4M4 20v-4h4",
  tts: "M4 10v4h4l5 4V6L8 10H4Zm12.5-3a5 5 0 0 1 0 10",
  loading: "M12 3a9 9 0 1 0 9 9",
  close: "M6 6l12 12M18 6 6 18",
  tag: "M3 12 12 3h8v8l-9 9-8-8Zm0 0h6",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm9 16-4.3-4.3",
  library: "M5 4h3v16H5V4Zm5 0h3v16h-3V4Zm5 2 3-1 4 14-3 1-4-14Z",
  review: "M5 4h14v16H5V4Zm3 0v16M11 8h5M11 12h5M11 16h4",
  explore: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-1 14 5-9-9 5 4 4Z",
  focus: "M4 9V5h4M16 5h4v4M4 15v4h4M16 19h4v-4M9 12h6",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5V11Z",
  prompt: "M5 4h14v16H5V4Zm3 5h8M8 14h8M8 18h5",
  trash: "M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5",
  paper: "M6 3h9l4 4v14H6V3Zm9 0v4h4M9 12h6M9 16h6M9 8h2",
  table: "M4 5h16v14H4V5Zm0 4h16M9 5v14M15 5v14",
  folder:
    "M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z",
  "folder-open":
    "M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3V6Zm0 3h18l-2 9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9Z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 9a8 8 0 0 1 16 0",
  users:
    "M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-9 9a7 7 0 0 1 12 0M16 14a6 6 0 0 1 6 7",
  calendar: "M5 6h14v14H5V6Zm0 4h14M9 4v4M15 4v4",
  "calendar-star":
    "M5 6h14v14H5V6Zm0 4h14M9 4v4M15 4v4M12 12l1 2 2 .3-1.5 1.4.4 2-1.9-1-1.9 1 .4-2L9 14.3l2-.3 1-2Z",
  target:
    "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z",
  lightning: "M13 2 4 14h6l-1 8 9-12h-6l1-8Z",
  tool: "M14.7 6.3a4 4 0 0 0-5 5L4 17l3 3 5.7-5.7a4 4 0 0 0 5-5l-2.5 2.5-2-2 1.5-3.5Z",
  brain:
    "M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 1 4 3 3 0 0 0 4 3 3 3 0 0 0 4-3 3 3 0 0 0 1-4 3 3 0 0 0-2-5 3 3 0 0 0-3-3Zm3 0v17",
  "image-stack": "M3 5h14v12H3V5Zm0 4 4-4 8 8",
  "image-multiple": "M3 5h14v12H3V5Zm3 9 3-3 2.5 2.5L13 11l3 3M16 8h5v13H8",
  download: "M12 4v12m0 0-4-4m4 4 4-4M5 20h14",
  "open-link": "M9 5H5v14h14v-4M11 13l8-8m0 0h-5m5 0v5",
  warning: "M12 4 2 20h20L12 4Zm0 6v4m0 3v.01",
  check: "M5 13l4 4 10-10",
  "check-circle": "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-4 9 3 3 5-6",
  "x-circle": "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-4 5 8 8m0-8-8 8",
  question: "M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3v.01",
  help: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 7v.01M11 11a3 3 0 0 1 6 0c0 2-3 2-3 4",
  block: "M5 5l14 14M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z",
  sparkle: "M12 3v4m0 10v4M3 12h4m10 0h4M6 6l3 3m6 6 3 3M6 18l3-3m6-6 3-3",
  idea: "M9 18h6m-5 3h4M12 3a6 6 0 0 0-4 10c1 1 1 2 1 3h6c0-1 0-2 1-3a6 6 0 0 0-4-10Z",
  bookmark: "M6 4h12v17l-6-4-6 4V4Z",
  flag: "M5 4v17M5 4h12l-2 4 2 4H5",
  fire: "M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 1-9Z",
  firecrawl:
    "M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 1-9ZM4 20h16",
  "thumbs-up":
    "M7 11v10H4V11h3Zm0 0 4-7a2 2 0 0 1 2 2v3h4a2 2 0 0 1 2 2.4l-1 5A2 2 0 0 1 17 19H7",
  "thumbs-down":
    "M7 13V3H4v10h3Zm0 0-4 7a2 2 0 0 0 2 2h3v3h4l1-3a2 2 0 0 0-2-2.4l-1-5A2 2 0 0 1 7 13Z",
  scale:
    "M12 3v18M5 7h14M5 7l-3 7a3 3 0 0 0 6 0L5 7Zm14 0-3 7a3 3 0 0 0 6 0l-3-7Z",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  pin: "M12 2v8M9 10h6l-1 4H10l-1-4ZM12 14v8",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5v.01M11 12h1v5h1",
  hourglass:
    "M5 3h14M7 3v3a5 5 0 0 0 5 5 5 5 0 0 0 5-5V3M7 21v-3a5 5 0 0 1 5-5 5 5 0 0 1 5 5v3M5 21h14",
  globe:
    "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
  home: "M4 11 12 4l8 7v9H4v-9Zm5 9v-5h6v5",
  logout: "M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5M10 17l5-5-5-5M15 12H3",
  server: "M5 4h14v6H5V4Zm0 10h14v6H5v-6ZM9 7h.01M9 17h.01",
  terminal: "M4 5h16v14H4V5Zm2 3 3 3-3 3M10 16h6",
  swap: "M3 8h14l-3-3M21 16H7l3 3",
  list: "M4 6h16M4 12h16M4 18h10",
  rocket: "M12 3c5 0 8 4 8 9l-4 1-1 4-3 1-3-1-1-4-4-1c0-5 3-9 8-9Z",
  robot:
    "M5 8h14v10H5V8Zm3 0V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v3M9 13h.01M15 13h.01M9 6h6",
  compass: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-3 12 2-7 7-2-2 7-7 2Z",
  database:
    "M5 5c0-1 3-2 7-2s7 1 7 2-3 2-7 2-7-1-7-2Zm0 6c0-1 3-2 7-2s7 1 7 2-3 2-7 2-7-1-7-2Zm0 6c0-1 3-2 7-2s7 1 7 2-3 2-7 2-7-1-7-2Z",
  share:
    "M6 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm12 6a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-6-3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-5 1 4-2m1-5 4 2",
  star: "M12 3l3 6 6 1-4.5 4 1 6-5.5-3-5.5 3 1-6L3 10l6-1 3-6Z",
  shield: "M12 3 4 6v6c0 5 3 8 8 9 5-1 8-4 8-9V6l-8-3Z",
  zap: "M13 2 4 14h6l-1 8 9-12h-6l1-8Z",
  cpu: "M5 8h14v8H5V8Zm3 0V5h2v3m4-3v3h2V5h-2m-2 14v-3h2v3m-4 0v-3h2v3M5 8h3M5 16h3m13-8h-3m3 8h-3",
  message: "M5 5h14v10H9l-4 4V5Z",
  sparkles:
    "M12 3l1 4 4 1-4 1-1 4-1-4-4-1 4-1 1-4ZM5 13l1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2Zm12 2 1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2Z",
};

export interface CreateSvgIconOptions {
  size?: number;
  strokeWidth?: number;
  className?: string;
  fill?: string;
  stroke?: string;
  spin?: boolean;
  title?: string;
}

export function createSvgIcon(
  doc: Document,
  name: IconName,
  options: CreateSvgIconOptions = {},
): SVGElement {
  const {
    size = 16,
    strokeWidth = 1.7,
    className,
    fill = "none",
    stroke = "currentColor",
    spin = false,
    title,
  } = options;

  const path = ICON_PATHS[name];
  if (!path) {
    throw new Error(`[seerai] Unknown icon: ${name}`);
  }

  const svg = doc.createElementNS(SVG_NS, "svg") as unknown as SVGElement;
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", fill);
  if (className) svg.setAttribute("class", className);
  if (spin) svg.setAttribute("data-spin", "true");
  if (title) {
    const t = doc.createElementNS(SVG_NS, "title");
    t.textContent = title;
    svg.appendChild(t);
  }
  svg.setAttribute("aria-hidden", title ? "false" : "true");

  const pathEl = doc.createElementNS(SVG_NS, "path");
  pathEl.setAttribute("d", path);
  pathEl.setAttribute("stroke", stroke);
  pathEl.setAttribute("stroke-width", String(strokeWidth));
  pathEl.setAttribute("stroke-linecap", "round");
  pathEl.setAttribute("stroke-linejoin", "round");
  svg.appendChild(pathEl);

  return svg;
}

export function setButtonIcon(
  button: HTMLElement,
  name: IconName,
  label?: string,
  size = 16,
): void {
  button.replaceChildren(createSvgIcon(button.ownerDocument!, name, { size }));
  if (label) {
    button.setAttribute("aria-label", label);
    button.title = label;
  }
}

const HTML_NS = "http://www.w3.org/1999/xhtml";

export function createIconButton(
  doc: Document,
  icon: IconName | string,
  title: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = doc.createElementNS(HTML_NS, "button") as HTMLButtonElement;
  btn.className = "seerai-icon-button";
  if (
    Object.prototype.hasOwnProperty.call(ICON_PATHS, icon) ||
    (typeof icon === "string" &&
      (ICON_PATHS as Record<string, string>)[icon] !== undefined)
  ) {
    btn.replaceChildren(createSvgIcon(doc, icon as IconName, { size: 14 }));
  } else {
    btn.textContent = icon;
  }
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return btn;
}

export function getIconPath(name: IconName): string {
  return ICON_PATHS[name];
}

export const ALL_ICON_NAMES: IconName[] = Object.keys(ICON_PATHS) as IconName[];

/**
 * Replace the button contents with a small loading (hourglass) icon.
 * Returns a function that restores the button to its prior state.
 */
export function setButtonLoading(
  button: HTMLElement,
  label = "",
  size = 14,
): () => void {
  const doc = button.ownerDocument!;
  const prevHTML = button.innerHTML;
  const prevDisabled = (button as HTMLButtonElement).disabled;
  const prevCursor = button.style.cursor;
  button.replaceChildren(
    createSvgIcon(doc, "hourglass", { size, strokeWidth: 1.8 }),
  );
  if (label) {
    const span = doc.createElementNS(HTML_NS, "span") as HTMLElement;
    span.textContent = label;
    button.appendChild(span);
  }
  button.style.cursor = "wait";
  return () => {
    button.innerHTML = prevHTML;
    (button as HTMLButtonElement).disabled = prevDisabled;
    button.style.cursor = prevCursor;
  };
}
