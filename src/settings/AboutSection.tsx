import { ExternalLink } from "lucide-react";
import { APP_VERSION } from "../appVersion";
import { openExternal } from "../lib/markdownLink";
import { Divider, Row } from "./controls";

const REPO_URL = "https://github.com/snatvb/delta-review";

const linkBtnClass =
  "inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function LinkButton({ label, href }: { label: string; href: string }) {
  return (
    <button type="button" className={linkBtnClass} onClick={() => openExternal(href)}>
      {label}
      <ExternalLink className="size-3 text-muted-foreground" />
    </button>
  );
}

export function AboutSection() {
  return (
    <div>
      <Row
        label="Version"
        hint="The app checks for updates on launch (see General)."
        control={<span className="font-mono text-[12px] font-medium text-muted-foreground">v{APP_VERSION}</span>}
      />

      <Divider />

      <Row
        label="GitHub repository"
        hint="Source code, docs, and release notes."
        control={<LinkButton label="snatvb/delta-review" href={REPO_URL} />}
      />

      <Divider />

      <Row
        label="Report an issue"
        hint="Bugs, feature ideas, and pull requests."
        control={<LinkButton label="Issues" href={`${REPO_URL}/issues`} />}
      />

      <div className="mt-6 rounded-lg border border-border/60 bg-muted/30 px-4 py-3 text-[12px] leading-relaxed text-muted-foreground">
        delta-review is a fork of{" "}
        <a
          href="https://github.com/darioielardi/delta"
          className="text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
          onClick={(e) => {
            e.preventDefault();
            openExternal("https://github.com/darioielardi/delta");
          }}
        >
          Delta
        </a>{" "}
        by Dario Ielardi, created and maintained by Andrei Avsenin. Released under the MIT License.
      </div>
    </div>
  );
}
