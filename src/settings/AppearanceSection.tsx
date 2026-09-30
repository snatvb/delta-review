import { useMemo } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useThemePref, type ThemePref } from "../theme";
import { useCodeFont, setCodeFontFamily, setCodeFontSize, installedMonoFonts, SIZE_OPTIONS } from "../codeFont";
import { Chevron, Divider, Row, selectClass } from "./controls";

const THEMES: { value: ThemePref; label: string; Icon: typeof Monitor }[] = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

export function AppearanceSection() {
  const [theme, setTheme] = useThemePref();
  const { family: fontFamily, size: fontSize } = useCodeFont();
  // Installed mono families (probed once) → "System Mono" default + whatever the
  // machine actually has. Keep the current pick listed even if it's not detected.
  const families = useMemo(() => {
    const found = installedMonoFonts();
    return fontFamily && !found.includes(fontFamily) ? [fontFamily, ...found] : found;
  }, [fontFamily]);

  return (
    <div>
      <Row
        label="Theme"
        hint="Match the system, or force light/dark."
        control={
          <ToggleGroup
            type="single"
            size="sm"
            value={theme}
            onValueChange={(v) => v && setTheme(v as ThemePref)}
            className="gap-0.5 rounded-lg bg-muted/70 p-0.5"
          >
            {THEMES.map(({ value, label, Icon }) => (
              <ToggleGroupItem
                key={value}
                value={value}
                aria-label={label}
                title={label}
                className="h-7 gap-1.5 rounded-md border-0 px-2.5 text-[12px] text-muted-foreground hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-sm"
              >
                <Icon className="size-3.5" />
                {label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        }
      />

      <Divider />

      <Row
        label="Code font"
        hint="Font family for diffs and code."
        control={
          <div className="relative">
            <select
              aria-label="Code font family"
              value={fontFamily}
              onChange={(e) => setCodeFontFamily(e.target.value)}
              className={selectClass}
            >
              <option value="">System Mono</option>
              {families.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
            <Chevron />
          </div>
        }
      />

      <Divider />

      <Row
        label="Code font size"
        hint="Size of code in the diff view."
        control={
          <div className="relative">
            <select
              aria-label="Code font size"
              value={fontSize}
              onChange={(e) => setCodeFontSize(Number(e.target.value))}
              className={selectClass}
            >
              {SIZE_OPTIONS.map((s) => (
                <option key={s} value={s}>{s}px</option>
              ))}
            </select>
            <Chevron />
          </div>
        }
      />
    </div>
  );
}
