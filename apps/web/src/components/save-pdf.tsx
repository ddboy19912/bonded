import { Button, Logo } from "./ui";

/**
 * Saves the report on the page as a PDF, through the browser's print dialog ("Save as PDF").
 * Only the element marked `data-print-root` prints, on a light page (index.css, "Print"). The
 * page's title names the file while the dialog is open.
 */
export function SavePdfButton({
  fileName,
  size = "md",
}: {
  fileName: string;
  /** The size of the buttons beside it. */
  size?: "sm" | "md";
}) {
  const save = () => {
    const title = document.title;
    document.title = fileName;
    // Folded sections print open, then fold again.
    const folded = [
      ...document.querySelectorAll<HTMLDetailsElement>("[data-print-root] details"),
    ].filter((d) => !d.open);
    for (const d of folded) d.open = true;
    const restore = () => {
      document.title = title;
      for (const d of folded) d.open = false;
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    window.print();
  };
  return (
    <Button kind="secondary" size={size} onClick={save}>
      Save as PDF
    </Button>
  );
}

/**
 * A report's letterhead on paper only: the Bonded lockup at the left; what the report is, when it
 * ran and where it came from at the right, in the app's mono labels; a hairline under it.
 */
export function PrintBrand({ kind, date }: { kind: string; date: string }) {
  return (
    <div className="mb-14 hidden items-end justify-between gap-8 border-b border-line pb-6 print:flex">
      <Logo className="h-8" />
      <div className="text-right font-mono text-[12px] leading-relaxed text-muted">
        <p className="text-soft">{kind}</p>
        <p>{date} · bondedhq.xyz</p>
      </div>
    </div>
  );
}

/** A preview report's letterhead: which kind of agent, and when it ran. */
export function PrintHeader({ world, ranAt }: { world: "vault" | "brokerage"; ranAt: string }) {
  return (
    <PrintBrand
      kind={`Preview report · ${world === "brokerage" ? "stock-trading" : "crypto-trading"} agent`}
      date={`Ran ${new Date(ranAt).toLocaleDateString("en-GB", { dateStyle: "long" })}`}
    />
  );
}

/** A report's PDF file name: "Bonded report, stock-trading agent, 16 Nov 2026". */
export function reportFileName(world: "vault" | "brokerage", ranAt: string): string {
  const day = new Date(ranAt).toLocaleDateString("en-GB", { dateStyle: "medium" });
  return `Bonded report, ${world === "brokerage" ? "stock-trading" : "crypto-trading"} agent, ${day}`;
}
