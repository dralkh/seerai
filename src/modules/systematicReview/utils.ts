/**
 * Utility functions for Systematic Review tab
 *
 * All icons are inline SVG with aria-label — zero emoji.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

export function createSvgIcon(
  doc: Document,
  pathData: string,
  ariaLabel: string,
  size: number = 16,
): SVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg") as unknown as SVGElement;
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-label", ariaLabel);
  svg.setAttribute("role", "img");
  svg.style.cssText = "flex-shrink: 0; pointer-events: none;";

  const path = doc.createElementNS(SVG_NS, "path");
  path.setAttribute("d", pathData);
  svg.appendChild(path);

  return svg;
}

export function createSvgButton(
  doc: Document,
  pathData: string,
  ariaLabel: string,
  onClick: () => void,
  size: number = 16,
): HTMLButtonElement {
  const btn = doc.createElement("button") as HTMLButtonElement;
  btn.setAttribute("aria-label", ariaLabel);
  btn.style.cssText = `
    display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; border: none; border-radius: 4px;
    background: transparent; color: var(--text-secondary); cursor: pointer;
    padding: 0; flex-shrink: 0;
  `;
  btn.addEventListener("mouseenter", () => {
    btn.style.backgroundColor = "var(--background-primary)";
    btn.style.color = "var(--text-primary)";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.backgroundColor = "transparent";
    btn.style.color = "var(--text-secondary)";
  });
  btn.addEventListener("click", onClick);

  const svg = createSvgIcon(doc, pathData, ariaLabel, size);
  btn.appendChild(svg);

  return btn;
}

// Common SVG path data
export const ICONS = {
  search:
    "M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z",
  close:
    "M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
  expand: "M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z",
  collapse: "M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z",
  sortAsc: "M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z",
  sortDesc: "M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8 8-8z",
  filter: "M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z",
  download: "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z",
  selectAll:
    "M3 5h2V3c-1.1 0-2 .9-2 2zm0 8h2v-2H3v2zm4 8h2v-2H7v2zM3 9h2V7H3v2zm10-6h-2v2h2V3zm6 0v2h2c0-1.1-.9-2-2-2zM5 21v-2H3c0 1.1.9 2 2 2zm-2-4h2v-2H3v2zM9 3H7v2h2V3zm2 18h2v-2h-2v2zm8-8h2v-2h-2v2zm0 8c1.1 0 2-.9 2-2h-2v2zm0-12h2V7h-2v2zm0 8h2v-2h-2v2zm-4 4h2v-2h-2v2zm0-16h2V3h-2v2zM3 3h2V1H3v2z",
  deselect:
    "M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14z",
  visibility:
    "M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z",
  hidden:
    "M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z",
  evidence:
    "M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z",
  gap: "M11 15h2v2h-2zm0-8h2v6h-2zm.99-5C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z",
  methodology:
    "M4 8h4V4H4v4zm6 12h4v-4h-4v4zm-6 0h4v-4H4v4zm0-6h4v-4H4v4zm6 0h4v-4h-4v4zm6-10v4h4V4h-4zm-6 4h4V4h-4v4zm6 6h4v-4h-4v4zm0 6h4v-4h-4v4z",
  matrix:
    "M3 3v18h18V3H3zm8 16H5v-6h6v6zm0-8H5V5h6v6zm8 8h-6v-6h6v6zm0-8h-6V5h6v6z",
  severityHigh: "M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z",
  severityMedium: "M1 21h22L12 2 1 21zm13-4h-4v-2h4v2zm0-4h-4V9h4v4z",
  severityLow: "M2 22l10-18 10 18H2z",
  add: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z",
  remove: "M19 13H5v-2h14v2z",
  refresh:
    "M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z",
  dragHandle: "M4 6h16V4H4v2zm0 7h16v-2H4v2zm0 7h16v-2H4v2z",
  check: "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
  warning: "M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z",
  document:
    "M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z",
  arrowDown: "M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8 8-8z",
};

export function getEvidenceStrengthColor(strength: string): string {
  switch (strength) {
    case "strong":
      return "#2e7d32";
    case "moderate":
      return "#f9a825";
    case "limited":
      return "#e65100";
    case "insufficient":
      return "#c62828";
    default:
      return "var(--text-secondary)";
  }
}

export function getEvidenceStrengthLabel(strength: string): string {
  switch (strength) {
    case "strong":
      return "Strong";
    case "moderate":
      return "Moderate";
    case "limited":
      return "Limited";
    case "insufficient":
      return "Insufficient";
    default:
      return strength;
  }
}

export function getSeverityColor(severity: string): string {
  switch (severity) {
    case "high":
      return "#c62828";
    case "medium":
      return "#e65100";
    case "low":
      return "#f9a825";
    default:
      return "var(--text-secondary)";
  }
}

export function getBiasColor(level: string): string {
  const l = level.toLowerCase();
  if (l.includes("low") || l.includes("minimal")) return "#2e7d32";
  if (l.includes("moderate") || l.includes("some")) return "#f9a825";
  if (l.includes("high") || l.includes("serious") || l.includes("critical"))
    return "#c62828";
  return "var(--text-secondary)";
}

export function formatAuthors(authors: string): string {
  if (!authors) return "";
  const parts = authors.split(",");
  if (parts.length <= 3) return authors;
  return parts.slice(0, 3).join(", ") + " et al.";
}

const SOURCE_LABEL_ADJECTIVES = [
  "swift",
  "calm",
  "bright",
  "clear",
  "bold",
  "fair",
  "keen",
  "warm",
  "cool",
  "deep",
  "soft",
  "wild",
  "pure",
  "true",
  "rich",
  "firm",
  "open",
  "wide",
  "high",
  "low",
  "new",
  "old",
  "thin",
  "thick",
  "fast",
  "slow",
  "strong",
  "light",
  "sharp",
  "smooth",
  "still",
  "fresh",
];

const SOURCE_LABEL_NOUNS = [
  "river",
  "ocean",
  "forest",
  "mountain",
  "meadow",
  "valley",
  "stream",
  "cloud",
  "stone",
  "flame",
  "spark",
  "wind",
  "rain",
  "frost",
  "snow",
  "leaf",
  "branch",
  "root",
  "seed",
  "field",
  "path",
  "bridge",
  "tower",
  "beacon",
  "horizon",
  "dawn",
  "dusk",
  "echo",
  "glade",
  "harbor",
  "summit",
];

export function generateSourceLabel(): string {
  const adj =
    SOURCE_LABEL_ADJECTIVES[
      Math.floor(Math.random() * SOURCE_LABEL_ADJECTIVES.length)
    ];
  const noun =
    SOURCE_LABEL_NOUNS[Math.floor(Math.random() * SOURCE_LABEL_NOUNS.length)];
  return `${adj}-${noun}`;
}

export function setupKeyboardShortcuts(
  container: HTMLElement,
  handlers: {
    focusSearch: () => void;
    clearFilter: () => void;
    selectAll: () => void;
  },
): void {
  container.addEventListener("keydown", (e: Event) => {
    const ke = e as KeyboardEvent;
    const isCtrl = ke.ctrlKey || ke.metaKey;

    if (isCtrl && ke.key === "f") {
      e.preventDefault();
      handlers.focusSearch();
    } else if (ke.key === "Escape") {
      e.preventDefault();
      handlers.clearFilter();
    } else if (isCtrl && ke.key === "a") {
      e.preventDefault();
      handlers.selectAll();
    }
  });
}
