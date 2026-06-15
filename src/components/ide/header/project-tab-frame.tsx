import type { PropsWithChildren } from "react";
import type { SparklesProps } from "@/components/ui/sparkles";
import Sparkles from "@/components/ui/sparkles";

export const ProjectTabFrame = ({
  children,
  sparklesPalette,
  streaming,
}: PropsWithChildren<{
  sparklesPalette: SparklesProps["palette"];
  streaming: boolean;
}>) => (
  <Sparkles
    className="w-full overflow-hidden"
    density={38}
    disabled={!streaming}
    groundGlow={true}
    height={10}
    palette={sparklesPalette}
    position="bottom"
    sizeMul={0.5}
    speed={3}
    style={{ position: "relative" }}
    sway={0}
  >
    {children}
  </Sparkles>
);
