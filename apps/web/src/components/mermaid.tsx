import { renderMermaidSVG } from "beautiful-mermaid"

type MermaidProps = {
  /** Mermaid source. Must come from authored MDX, never from user input. */
  chart: string
  /** Accessible description of the diagram. */
  title: string
}

// Colors reference the app tokens so the diagram follows light and dark themes.
const diagramColors = {
  bg: "var(--background)",
  fg: "var(--foreground)",
  line: "var(--muted-foreground)",
  accent: "var(--primary)",
  muted: "var(--muted-foreground)",
  surface: "var(--card)",
  border: "var(--border)",
  transparent: true,
} as const

/**
 * Renders Mermaid to inline SVG on the server. No client JavaScript, no DOM
 * and no eval, which keeps it compatible with the production CSP.
 */
export function Mermaid({ chart, title }: MermaidProps) {
  const svg = renderMermaidSVG(chart.trim(), diagramColors)

  return (
    <figure
      role="img"
      aria-label={title}
      className="my-4 overflow-x-auto rounded-md border bg-card p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
    >
      <div dangerouslySetInnerHTML={{ __html: svg }} />
    </figure>
  )
}
