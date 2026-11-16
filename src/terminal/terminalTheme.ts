import type { ITheme } from "@xterm/xterm";

const DARK_ANSI: ITheme = {
  black: "#3b3b3b",
  red: "#f47067",
  green: "#57ab5a",
  yellow: "#c69026",
  blue: "#539bf5",
  magenta: "#b083f0",
  cyan: "#39c5cf",
  white: "#d1d5db",
  brightBlack: "#6e7681",
  brightRed: "#ff938a",
  brightGreen: "#6bc46d",
  brightYellow: "#daaa3f",
  brightBlue: "#6cb6ff",
  brightMagenta: "#dcbdfb",
  brightCyan: "#56d4dd",
  brightWhite: "#f5f5f5",
};

const LIGHT_ANSI: ITheme = {
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#7d4e00",
  blue: "#0550ae",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
};

function token(styles: CSSStyleDeclaration, name: string): string | undefined {
  return styles.getPropertyValue(name).trim() || undefined;
}

export function isDarkDocument(): boolean {
  return document.documentElement.classList.contains("dark");
}

export function terminalTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const primary = token(styles, "--primary");
  return {
    ...(isDarkDocument() ? DARK_ANSI : LIGHT_ANSI),
    background: token(styles, "--code"),
    foreground: token(styles, "--foreground"),
    cursor: primary,
    cursorAccent: token(styles, "--code"),
    selectionBackground: primary && `color-mix(in oklch, ${primary} 30%, transparent)`,
  };
}
